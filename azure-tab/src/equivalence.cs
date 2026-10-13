using System;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis.Text;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using WasmSharp.Core.Services;

// Only this shipped analyzer is executed. PR text is decoded as data and parsed/emitted, never loaded or invoked.
class ReviewEquivalence
{
    class File { public string path, original, modified; public bool formattingOnly, usingsOnly, renameOnly; }
    class Pair { public string ns, from, to, kind; }
    static Pair[] namespacePairs = Array.Empty<Pair>();
    static string NormalizeNamespace(string name)
    {
        var prefix = name.StartsWith("global::") ? "global::" : "";
        var value = name.Substring(prefix.Length);
        foreach (var pair in namespacePairs.OrderByDescending(pair => pair.from.Length))
            if (value == pair.from || value.StartsWith(pair.from + ".")) return prefix + pair.to + value.Substring(pair.from.Length);
        return name;
    }
    static IEnumerable<INamedTypeSymbol> Types(INamespaceSymbol ns)
    {
        foreach (var type in ns.GetTypeMembers()) yield return type;
        foreach (var child in ns.GetNamespaceMembers()) foreach (var type in Types(child)) yield return type;
    }
    static string MetadataName(INamedTypeSymbol type) => type.ContainingType != null
        ? MetadataName(type.ContainingType) + "+" + type.MetadataName
        : (type.ContainingNamespace.IsGlobalNamespace ? "" : type.ContainingNamespace.ToDisplayString() + ".") + type.MetadataName;
    static string D(string value) => Encoding.UTF8.GetString(Convert.FromBase64String(value));
    static string E(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    static readonly CSharpParseOptions ParseOptions = new CSharpParseOptions(LanguageVersion.Latest);
    static readonly MetadataReference[] References = MetadataReferenceCache.MetadataReferences
        .Where(reference => reference.Display == null || !reference.Display.Contains("WasmSharp.Core"))
        .ToArray();
    static SyntaxTree Parse(string text, string path) => CSharpSyntaxTree.ParseText(SourceText.From(text), ParseOptions, path);
    static bool Unsupported(SyntaxTree tree) => tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)
        || tree.GetRoot().DescendantTrivia().Any(t => t.IsDirective);
    static CSharpCompilation Compile(IEnumerable<SyntaxTree> trees) =>
        CSharpCompilation.Create("ReviewSnapshot", trees, References, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithConcurrentBuild(false));
    static bool Errors(CSharpCompilation compilation) => compilation.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
    static byte[] Emit(CSharpCompilation compilation)
    {
        using var stream = new MemoryStream();
        if (!compilation.Emit(stream).Success) return null;
        var bytes = stream.ToArray();
        using var pe = new PEReader(new MemoryStream(bytes));
        var metadata = pe.GetMetadataReader();
        // Random MVID and PE timestamp are not executable semantics. All other metadata and IL must match.
        var mvid = metadata.GetGuid(metadata.GetModuleDefinition().Mvid).ToByteArray();
        int found = 0;
        for (int offset = 0; offset <= bytes.Length - mvid.Length; offset++)
        {
            bool matches = true;
            for (int j = 0; j < mvid.Length; j++) if (bytes[offset + j] != mvid[j]) { matches = false; break; }
            if (!matches) continue;
            Array.Clear(bytes, offset, mvid.Length); found++;
        }
        if (found != 1) return null;
        Array.Clear(bytes, BitConverter.ToInt32(bytes, 0x3c) + 8, 4);
        return bytes;
    }
    static bool SameEmission(SyntaxTree before, SyntaxTree after)
    {
        var left = Emit(Compile(new[] { before }));
        var right = Emit(Compile(new[] { after }));
        return left != null && right != null && left.SequenceEqual(right);
    }
    static string Identity(ISymbol symbol, Dictionary<INamedTypeSymbol, INamedTypeSymbol> renames, bool normalize)
    {
        if (symbol == null) return "";
        if (symbol is INamespaceSymbol ns) return "namespace:" + (normalize ? NormalizeNamespace(ns.ToDisplayString()) : ns.ToDisplayString());
        if (symbol is INamedTypeSymbol type)
        {
            var definition = type.OriginalDefinition;
            if (normalize && renames.TryGetValue(definition, out var replacement)) definition = replacement;
            return definition.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) + "@" + definition.ContainingAssembly?.Identity.ToString()
                + (type.IsGenericType ? "[" + string.Join(",", type.TypeArguments.Select(t => Identity(t, renames, normalize))) + "]" : "");
        }
        if (symbol is IArrayTypeSymbol array) return Identity(array.ElementType, renames, normalize) + "[" + array.Rank + "]";
        if (symbol is IMethodSymbol method) return Identity(method.ContainingType, renames, normalize) + "." + method.MetadataName + "`" + method.Arity
            + "(" + string.Join(",", method.Parameters.Select(p => p.RefKind + ":" + Identity(p.Type, renames, normalize))) + "):" + Identity(method.ReturnType, renames, normalize);
        if (symbol is IPropertySymbol property) return Identity(property.ContainingType, renames, normalize) + "." + property.MetadataName + ":" + Identity(property.Type, renames, normalize);
        if (symbol is IFieldSymbol field) return Identity(field.ContainingType, renames, normalize) + "." + field.MetadataName + ":" + Identity(field.Type, renames, normalize);
        if (symbol is ILocalSymbol local) return "local:" + local.Name + ":" + Identity(local.Type, renames, normalize);
        if (symbol is IParameterSymbol parameter) return "parameter:" + parameter.Ordinal + ":" + Identity(parameter.Type, renames, normalize);
        return symbol.Kind + ":" + symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    }
    static bool SameBindings(SyntaxTree before, SyntaxTree after, CSharpCompilation left, CSharpCompilation right, Dictionary<INamedTypeSymbol, INamedTypeSymbol> renames)
    {
        SyntaxNode[] Names(SyntaxTree tree) => tree.GetRoot().DescendantNodes().Where(node =>
            node is NameSyntax && !(node.Parent is QualifiedNameSyntax) && !(node.Parent is AliasQualifiedNameSyntax) && !(node.Parent is MemberAccessExpressionSyntax)
            || node is MemberAccessExpressionSyntax && !(node.Parent is MemberAccessExpressionSyntax)).ToArray();
        var oldNodes = Names(before);
        var newNodes = Names(after);
        if (oldNodes.Length != newNodes.Length || before.GetRoot().DescendantNodes().OfType<IdentifierNameSyntax>().Any(n => n.Identifier.ValueText == "nameof" || n.Identifier.ValueText == "dynamic")
            || before.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Any(n => n.Expression.ToString() == "nameof")) return false;
        var oldModel = left.GetSemanticModel(before); var newModel = right.GetSemanticModel(after); bool mapped = false;
        for (int i = 0; i < oldNodes.Length; i++)
        {
            var a = oldModel.GetSymbolInfo(oldNodes[i]); var b = newModel.GetSymbolInfo(newNodes[i]);
            if (a.CandidateSymbols.Length != 0 || b.CandidateSymbols.Length != 0) return false;
            if (Identity(a.Symbol, renames, true) != Identity(b.Symbol, renames, false)) return false;
            if (Identity(oldModel.GetTypeInfo(oldNodes[i]).Type, renames, true) != Identity(newModel.GetTypeInfo(newNodes[i]).Type, renames, false)) return false;
            if (oldNodes[i].ToString() != newNodes[i].ToString())
            {
                bool renamedType = a.Symbol is INamedTypeSymbol oldType && b.Symbol is INamedTypeSymbol newType
                    && renames.TryGetValue(oldType.OriginalDefinition, out var expected) && SymbolEqualityComparer.Default.Equals(expected, newType.OriginalDefinition);
                bool relocated = a.Symbol != null && b.Symbol != null
                    && NormalizeNamespace(oldNodes[i].ToString()) == newNodes[i].ToString()
                    && Identity(a.Symbol, renames, true) != Identity(a.Symbol, renames, false);
                if (!renamedType && !relocated) return false;
                mapped = true;
            }
        }
        return mapped;
    }
    public static void Main(string[] args)
    {
        __REVIEW_DATA__
        var before = files.Select(f => Parse(f.original, f.path)).ToArray();
        var after = files.Select(f => Parse(f.modified, f.path)).ToArray();
        var oldCompilation = Compile(before); var newCompilation = Compile(after);
        bool contextValid = !before.Any(Unsupported) && !after.Any(Unsupported) && !Errors(oldCompilation) && !Errors(newCompilation);
        var renames = new Dictionary<INamedTypeSymbol, INamedTypeSymbol>(SymbolEqualityComparer.Default);
        namespacePairs = pairs.Where(pair => pair.kind == "namespace").ToArray();
        if (contextValid)
        {
            foreach (var pair in pairs.Where(pair => pair.kind != "namespace"))
            {
                var ns = pair.ns; var prefix = string.IsNullOrEmpty(ns) ? "" : ns + ".";
                var oldType = oldCompilation.GetTypeByMetadataName(prefix + pair.from);
                var newType = newCompilation.GetTypeByMetadataName(prefix + pair.to);
                if (oldType != null && newType != null && oldType.TypeKind == newType.TypeKind) renames[oldType] = newType;
            }
            foreach (var oldType in Types(oldCompilation.GlobalNamespace))
            {
                var name = MetadataName(oldType); var normalized = NormalizeNamespace(name);
                if (normalized == name) continue;
                var newType = newCompilation.GetTypeByMetadataName(normalized);
                if (newType != null && oldType.TypeKind == newType.TypeKind) renames[oldType] = newType;
            }
        }

        bool bulkEquivalent = false;
        if (contextValid && files.All(file => (file.formattingOnly || file.usingsOnly) && !file.renameOnly))
        {
            var leftBytes = Emit(oldCompilation); var rightBytes = Emit(newCompilation);
            bulkEquivalent = leftBytes != null && rightBytes != null && leftBytes.SequenceEqual(rightBytes);
        }
        for (int i = 0; i < files.Length; i++)
        {
            var file = files[i]; bool formatting = false, usings = false, rename = false; string reason = "Not a supported equivalence candidate";
            bool candidate = file.formattingOnly || file.usingsOnly;
            if (!Unsupported(before[i]) && !Unsupported(after[i]))
            {
                if (candidate)
                {
                    bool identical = bulkEquivalent || SameEmission(before[i], after[i]);
                    formatting = identical && file.formattingOnly;
                    usings = identical && file.usingsOnly;
                    reason = identical ? "Roslyn verified identical emitted assembly content (excluding timestamp and module ID)" : "Changed emission or unresolved references; kept visible";
                }
                if (file.renameOnly)
                {
                    rename = contextValid && SameBindings(before[i], after[i], oldCompilation, newCompilation, renames);
                    reason = rename ? "Roslyn verified references bind to the mapped renamed type" : "Rename binding could not be verified; kept visible";
                }
            }
            else reason = "Syntax errors or preprocessor directives; kept visible";
            Console.WriteLine(E(file.path) + "|" + formatting + "|" + usings + "|" + rename + "|" + E(reason));
        }

    }
}
