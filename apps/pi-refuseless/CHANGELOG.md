# Changelog

## [Unreleased]

### New

- Refuseless appears in Pi's `/login` as an API-key provider. `/model` lists every model Refuseless returns for the key, with each model's context length and thinking levels, and Pi refreshes the model list after login and when `/model` opens. Requests use only the thinking levels a model supports. When you pick a model in a session with no thinking level yet, it starts at the model's default level instead of `off`.
- While a Refuseless model is active, interactive Pi's status line shows the credits a new request can use, read again after each reply. `/pi-refuseless` shows the available amount, balance, reserved amount and key limit, and turns the status line on or off; the choice is saved in `refuseless.json` in Pi's agent directory. Reading the balance spends no credits.
- Each model keeps the `abliterated` flag Refuseless reports for it, and `cli models` shows it, so abliterated models are told apart by the flag instead of the model ID.
