# SecureExam Desktop

Electron shell for the SecureExam client.

## Development

From the repository root, use `npm run dev`. The desktop app loads the local Vite client.

## Packaged build configuration

Set these environment variables before launching a packaged build:

```text
ELECTRON_START_URL=https://your-secureexam-client.example
ELECTRON_API_URL=https://your-secureexam-api.example/api
```

The shell keeps Node integration disabled, enables context isolation and sandboxing, blocks unapproved navigation, and grants camera/microphone access only to the configured application origin.
