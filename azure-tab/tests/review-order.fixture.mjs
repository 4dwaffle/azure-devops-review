export const description=[
 '## Review order',
 '',
 '1. `src/TouchlessMzdy.Logic/PayrollWorkers/SetRsmAdministratorUsecase.cs` — constructor dependencies, authorization, target checks and role mutation.',
 '2. `src/TouchlessMzdy.Logic/PayrollWorkers/RsmAdministratorChangedNotification.cs`, resources and `TouchlessMzdy.Logic.csproj` — audit metadata and generated localized messages.',
 '3. `src/TouchlessMzdy.Logic/PayrollWorkers/README.md` and `src/TouchlessMzdy.Logic/DataSeeding/README.md` — operation boundaries, DoD evidence and existing samples.',
 '4. `src/TouchlessMzdy.Authentication.Tests/RsmAdministratorTests.cs` — persisted permissions, access isolation, rejected actions, concurrency, cancellation and failure behavior.'
].join('\n');
export const paths=[
 'src/TouchlessMzdy.Logic/PayrollWorkers/SetRsmAdministratorUsecase.cs',
 'src/TouchlessMzdy.Logic/PayrollWorkers/RsmAdministratorChangedNotification.cs',
 'src/TouchlessMzdy.Logic/TouchlessMzdy.Logic.csproj',
 'src/TouchlessMzdy.Logic/PayrollWorkers/README.md',
 'src/TouchlessMzdy.Logic/DataSeeding/README.md',
 'src/TouchlessMzdy.Authentication.Tests/RsmAdministratorTests.cs',
 'Other.md',
 'src/TouchlessMzdy.Logic/Resources/Messages.resx'
];
export const files=paths.map((path,index)=>({path,status:'M',original:'before',modified:'after',fingerprint:`review-order-${index}`})).sort((a,b)=>a.path.localeCompare(b.path));
