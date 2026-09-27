# Sample corpus

A minimal knowledge base in exactly the layout the `on-boarding` ingestion Lambda produces, so a
brand-new setup can be tested end to end before real ingestion runs. See step A2 of
[docs/SLACK-BOT-AWS-SETUP.md](../../../docs/SLACK-BOT-AWS-SETUP.md).

```
onboarding/                                   ← content prefix: the Bedrock data source ingests this
  saturam-cli/                                ← project slug
    confluence/                               ← source category
      getting-started.md                      ← the document
      getting-started.md.metadata.json        ← its metadata, beside it with ".metadata.json" appended
      slack-bot.md
      slack-bot.md.metadata.json
onboarding-state/                             ← state prefix: never ingested
  registry.json                               ← the projects that exist
```

The rules the bot relies on:

- The `project` metadata value must equal the project's `slug` in `registry.json`. Project-scoped
  searches filter on it.
- `url` and `title` in the metadata are what the bot shows under an answer as its sources.
- `registry.json` must sit under the state prefix, **not** the content prefix, or Bedrock indexes
  it as if it were documentation.

Upload both folders to the bucket root, keeping the paths:
`s3://<BUCKET_NAME>/onboarding/…` and `s3://<BUCKET_NAME>/onboarding-state/registry.json`.
Once real ingestion runs, delete the sample project or leave it in: it answers questions about this
bot.
