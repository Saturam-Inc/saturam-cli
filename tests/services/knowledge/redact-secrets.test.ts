import { redactSecrets } from "../../../src/services/knowledge/redact-secrets";

describe("redactSecrets", () => {
    it("redacts vendor-prefixed keys", () => {
        const { text, redacted } = redactSecrets(
            "Use AKIAIOSFODNN7EXAMPLE for AWS, sk-abcdefghijklmnopqrstuvwxyz1234 for OpenAI and glpat-AbCdEfGhIjKlMnOpQrSt for GitLab.",
        );

        expect(text).toBe("Use [redacted] for AWS, [redacted] for OpenAI and [redacted] for GitLab.");
        expect(redacted).toBe(3);
    });

    it("redacts bearer tokens but keeps the word Bearer, so the reader still knows the scheme", () => {
        const { text } = redactSecrets("Send Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123XYZ");

        expect(text).toBe("Send Authorization: Bearer [redacted]");
    });

    it("redacts only the password inside a connection string", () => {
        const { text } = redactSecrets("engine_url = postgresql://mrf_user:Sup3rS3cret!@db.example.com:5432/mrf_prod");

        expect(text).toBe("engine_url = postgresql://mrf_user:[redacted]@db.example.com:5432/mrf_prod");
    });

    it("redacts the value of a password or key assignment", () => {
        const { text } = redactSecrets('MAIL_PASSWORD = "hunter2-2024"\napi_key: xK9v2mPq8wLn4bZt');

        expect(text).toBe('MAIL_PASSWORD = "[redacted]"\napi_key: [redacted]');
    });

    it("leaves placeholders and code references alone", () => {
        const input = 'password = os.environ["DB_PASSWORD"]\ntoken: <your-token-here>\nsecret_key = process.env.SECRET';

        expect(redactSecrets(input)).toEqual({ text: input, redacted: 0 });
    });

    it("leaves prose that merely talks about passwords alone", () => {
        const input = "The password is stored in IAM/config.py and the token is validated by GET /iam/validate.";

        expect(redactSecrets(input)).toEqual({ text: input, redacted: 0 });
    });

    it("leaves a short, wordlike value alone, since matching it would mean matching language", () => {
        // Accepted gap, documented in the module: the prompt rule covers low-entropy secrets.
        const input = 'The JWT secret is md5("mrfsecret").';

        expect(redactSecrets(input)).toEqual({ text: input, redacted: 0 });
    });

    it("counts every redaction", () => {
        const { redacted } = redactSecrets("AKIAIOSFODNN7EXAMPLE and AKIAI44QH8DHBEXAMPLE");

        expect(redacted).toBe(2);
    });
});
