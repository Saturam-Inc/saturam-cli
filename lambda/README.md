# SAT-CLI Remote Credential Lambda

Returns AWS credentials to SAT-CLI so developers don't need local AWS credentials
to use Bedrock.

```
SAT-CLI -> Remote URL -> API Gateway -> Lambda -> Secrets Manager -> credentials -> SAT-CLI -> Bedrock
```

The Lambda **only reads a secret from AWS Secrets Manager and returns it**. It does
**not** call Bedrock. Bedrock is invoked by SAT-CLI using the returned credentials.

## Endpoint

`GET /credentials`

- If `EXPECTED_TOKEN` is set on the Lambda, requests must include
  `Authorization: Bearer <token>`. Otherwise no token is required (token is optional).
- Response body:

  ```json
  {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "sessionToken": "...",     // optional
    "expiration": "2026-01-01T00:00:00Z"  // optional
  }
  ```

## Secret format (Secrets Manager)

Store a JSON secret with these keys (PascalCase and snake_case are also accepted):

```json
{
  "accessKeyId": "AKIA...",
  "secretAccessKey": "...",
  "sessionToken": "...",
  "expiration": "2026-01-01T00:00:00Z"
}
```

## Deploy (AWS SAM)

```bash
sam build
sam deploy --guided \
  --parameter-overrides SecretId=<secret-name-or-arn> ExpectedToken=<optional-token>
```

The `CredentialsUrl` output is the value to set as the SAT-CLI remote URL during
`sat-cli init` (SAT-CLI appends `/credentials` automatically).

## Environment variables

| Variable         | Required | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `SECRET_ID`      | yes      | Name or ARN of the Secrets Manager secret.               |
| `EXPECTED_TOKEN` | no       | Shared token; when set, requests must present it.        |
