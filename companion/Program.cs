using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    public static async Task<int> Main()
    {
        try
        {
            var input = await Console.In.ReadToEndAsync();
            if (Encoding.UTF8.GetByteCount(input) > 64 * 1024 * 1024) throw new InvalidDataException();
            var request = JsonSerializer.Deserialize<Request>(input, Json) ?? throw new InvalidDataException();
            if (request.Before.Length == 0 || request.Before.Length > 300 || request.After.Length > 300
                || request.Candidates.Length > 10000 || request.Pairs.Length > 1000) throw new InvalidDataException();
            var before = Compile(request.Before);
            var after = Compile(request.After);
            if (!before.Keys.Order().SequenceEqual(after.Keys.Order())) throw new InvalidDataException();
            var pairs = request.Pairs.Select(pair => new ReviewEquivalence.Pair
                { ns = pair.Namespace, from = pair.From, to = pair.To, kind = pair.Kind }).ToArray();
            var checks = request.Candidates.ToDictionary(candidate => candidate.Path, _ => new List<bool>());
            foreach (var id in before.Keys)
            {
                var left = before[id]; var right = after[id];
                var mappings = ReviewEquivalence.NativeRenameMap(left.Compilation, right.Compilation, pairs);
                foreach (var candidate in request.Candidates)
                {
                    var hasBefore = left.Trees.TryGetValue(candidate.OldPath, out var oldTree);
                    var hasAfter = right.Trees.TryGetValue(candidate.Path, out var newTree);
                    if (!hasBefore && !hasAfter) continue;
                    checks[candidate.Path].Add(hasBefore && hasAfter
                        && ReviewEquivalence.NativeRenameEquivalent(oldTree, newTree, left.Compilation, right.Compilation, mappings));
                }
            }
            var results = request.Candidates.Select(candidate =>
            {
                var values = checks[candidate.Path]; var verified = values.Count > 0 && values.All(value => value);
                return new { candidate.Path, RenameOnly = verified, SemanticVerified = verified,
                    SemanticReason = verified ? "Local Roslyn verified mapped reference bindings in every complete owning project"
                        : "Local compiler could not verify every owning project; kept visible" };
            }).ToArray();
            Console.WriteLine(JsonSerializer.Serialize(new { ContextValid = true, Results = results }, Json));
            return 0;
        }
        catch
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ContextValid = false,
                Error = "Local compiler context is incomplete, unsupported, changed or unresolved; kept visible", Results = Array.Empty<object>() }, Json));
            return 1;
        }
    }

    private static Dictionary<string, Snapshot> Compile(Project[] projects)
    {
        if (projects.Select(project => project.Id).Distinct(StringComparer.Ordinal).Count() != projects.Length) throw new InvalidDataException();
        var inputs = projects.ToDictionary(project => project.Id, StringComparer.Ordinal);
        var outputs = new Dictionary<string, Snapshot>(StringComparer.Ordinal);
        var pending = new HashSet<string>(StringComparer.Ordinal);
        long referenceBytes = 0;
        Snapshot Build(string id)
        {
            if (outputs.TryGetValue(id, out var cached)) return cached;
            if (!inputs.TryGetValue(id, out var project) || !pending.Add(id) || !project.Complete
                || string.IsNullOrWhiteSpace(project.AssemblyName) || project.Sources.Length == 0
                || project.Sources.Length > 10000 || project.References.Length > 1000
                || project.Sources.Select(source => source.Path).Distinct(StringComparer.Ordinal).Count() != project.Sources.Length
                || project.ProjectReferences.Distinct(StringComparer.Ordinal).Count() != project.ProjectReferences.Length) throw new InvalidDataException();
            if (!LanguageVersionFacts.TryParse(project.Options.LanguageVersion, out var language)) throw new InvalidDataException();
            var parseOptions = new CSharpParseOptions(language, Value<DocumentationMode>(project.Options.DocumentationMode), SourceCodeKind.Regular, project.Options.Symbols);
            var trees = project.Sources.Select(source => CSharpSyntaxTree.ParseText(
                SourceText.From(source.Text, Encoding.UTF8), parseOptions, source.CompilerPath)).ToArray();
            var references = new List<MetadataReference>();
            foreach (var reference in project.References)
            {
                if (!Path.IsPathFullyQualified(reference.Path) || reference.Sha256.Length != 64) throw new InvalidDataException();
                var info = new FileInfo(reference.Path);
                if (info.Length > 32 * 1024 * 1024 || (referenceBytes += info.Length) > 256 * 1024 * 1024) throw new InvalidDataException();
                var bytes = File.ReadAllBytes(reference.Path);
                if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(reference.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
                references.Add(MetadataReference.CreateFromImage(ImmutableArray.Create(bytes)));
            }
            foreach (var dependency in project.ProjectReferences)
            {
                var compilation = Build(dependency);
                using var stream = new MemoryStream();
                if (!compilation.Compilation.Emit(stream).Success) throw new InvalidDataException();
                references.Add(MetadataReference.CreateFromImage(ImmutableArray.Create(stream.ToArray())));
            }
            var options = new CSharpCompilationOptions(Value<OutputKind>(project.Options.OutputKind))
                .WithOptimizationLevel(Value<OptimizationLevel>(project.Options.OptimizationLevel))
                .WithNullableContextOptions(Value<NullableContextOptions>(project.Options.NullableContextOptions))
                .WithAllowUnsafe(project.Options.AllowUnsafe).WithOverflowChecks(project.Options.CheckOverflow)
                .WithPlatform(Value<Platform>(project.Options.Platform)).WithUsings(project.Options.Usings)
                .WithWarningLevel(project.Options.WarningLevel).WithMetadataImportOptions(Value<MetadataImportOptions>(project.Options.MetadataImportOptions))
                .WithDeterministic(true).WithConcurrentBuild(false);
            var result = CSharpCompilation.Create(project.AssemblyName, trees, references, options);
            if (result.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)) throw new InvalidDataException();
            var snapshot = new Snapshot(result, project.Sources.Select((source, index) => (source.Path, Tree: (SyntaxTree)trees[index])).ToDictionary(value => value.Path, value => value.Tree, StringComparer.Ordinal));
            outputs.Add(id, snapshot); pending.Remove(id); return snapshot;
        }
        foreach (var project in projects) Build(project.Id);
        return outputs;
    }

    private static T Value<T>(string value) where T : struct, Enum =>
        Enum.TryParse<T>(value, false, out var parsed) && Enum.IsDefined(parsed) ? parsed : throw new InvalidDataException();

    private sealed record Request(Project[] Before, Project[] After, Candidate[] Candidates, Pair[] Pairs);
    private sealed record Candidate(string Path, string OldPath);
    private sealed record Pair(string Namespace, string From, string To, string Kind);
    private sealed record Project(string Id, string AssemblyName, bool Complete, Source[] Sources, Reference[] References, string[] ProjectReferences, Options Options);
    private sealed record Snapshot(CSharpCompilation Compilation, Dictionary<string, SyntaxTree> Trees);
    private sealed record Source(string Path, string CompilerPath, string Text);
    private sealed record Reference(string Path, string Sha256);
    private sealed record Options(string LanguageVersion, string DocumentationMode, string[] Symbols, string OutputKind,
        string OptimizationLevel, string NullableContextOptions, bool AllowUnsafe, bool CheckOverflow, string Platform,
        string[] Usings, int WarningLevel, string MetadataImportOptions);
}
