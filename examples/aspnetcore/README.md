# ASP.NET Core example

A small billing API with an audit trail, built on `Logbird.AspNetCore`. It shows the three patterns most backends
need. Copy them into your own app:

| Pattern | Where | What Logbird records |
| --- | --- | --- |
| Sign-in | `POST /sign-in` | `user.signed_in` (the event names the user, who is not on the request yet) and `user.sign_in_failed` |
| A record change | `PUT /invoices/{id}/status` | `invoice.status_changed` with the status before and after, the user and tenant from the request |
| A background job | `POST /invoices/{id}/send` | `invoice.send_requested`, then `invoice.emailed` from the worker: same operation, same user, linked as parent and child |

Everything is fictional: two demo users, three invoices in memory, an in-process job queue.

## Run it

You need the .NET 8 SDK (or newer) and a Logbird server with a project and an ingest key.

```sh
cd examples/aspnetcore
dotnet user-secrets set Logbird:IngestKey <your ingest key>
# If your Logbird is not at http://127.0.0.1:4601:
dotnet user-secrets set Logbird:Endpoint https://audit.example.com
dotnet run
```

The API listens on `http://127.0.0.1:4740`. In another terminal:

```sh
B=http://127.0.0.1:4740
curl -s -X POST $B/sign-in -H 'content-type: application/json' -d '{"email":"ana@example.com","password":"nope"}'
curl -s -c cookies.txt -X POST $B/sign-in -H 'content-type: application/json' -d '{"email":"ana@example.com","password":"correct-horse"}'
curl -s -b cookies.txt -X PUT $B/invoices/inv_1001/status -H 'content-type: application/json' -d '{"status":"sent"}'
curl -s -b cookies.txt -X POST $B/invoices/inv_1001/send
curl -s -b cookies.txt -X PUT $B/invoices/inv_2001/status -H 'content-type: application/json' -d '{"status":"void"}'   # another tenant's invoice: 404
```

Each call that records an event returns its id.

## Check the trail

Open the project in the Logbird console. You should see, newest last:

- `user.sign_in_failed` (outcome failure, no actor)
- `user.signed_in` by `user_ana`, tenant `acct_acme`
- `invoice.status_changed` on `invoice:inv_1001`, status `draft` → `sent`, with the IP and user agent of your `curl`
- `invoice.send_requested`, and `invoice.emailed` with executor `worker:invoice-mailer` and the job id. It keeps `user_ana`
  as actor and shows `invoice.send_requested` as its parent. Filter by its `operation:"…"` to see the two together.

Or read them with a read key:

```sh
curl -s -H "Authorization: Bearer <read key>" "http://127.0.0.1:4601/v1/events?limit=10"
```

## What to take from it

- `Program.cs`: `AddLogbird` from configuration, `UseLogbird`, and three endpoints that each call `IAuditLog.Record`
  once, after the change succeeds.
- `Invoices.cs`: the worker turns the carrier from the job payload back into an `IAuditLog` with
  `IAuditLogFactory.ForJob`.
- In your project, replace the `ProjectReference` in the `.csproj` with `<PackageReference Include="Logbird.AspNetCore" />`
  once the package is published.

The full guide is [docs/sdk-dotnet.md](../../docs/sdk-dotnet.md).
