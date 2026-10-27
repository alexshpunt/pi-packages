# Changelog

## [Unreleased]

### New

- Refuseless appears in Pi's `/login` as an API-key provider. `/model` lists every model Refuseless returns for the key, with each model's context length and thinking levels, and Pi refreshes the model list after login and when `/model` opens. Requests use only the thinking levels a model supports. When you pick a model in a session with no thinking level yet, it starts at the model's default level instead of `off`.
