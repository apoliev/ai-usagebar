# Provider marks

Monochrome SVGs for the panel badge, the popup's vendor headers and the
preferences pages. Each file is named `<id>-symbolic.svg`, where `<id>` is the
vendor id from `lib/vendors.js`, so the extension finds a mark by name with no
lookup table. The `-symbolic` suffix makes GNOME Shell and GTK recolor it to the
surrounding text color, on light and dark themes.

A vendor without a mark — only the user-named custom provider — uses the
generic `ai-symbolic.svg`. Marks can be turned off in preferences
(**Show vendor logos**), which brings back the text badge and the generic icon.

The marks identify each provider nominatively; no affiliation with or
endorsement by the brand owners is implied.

| File | Used for | Source | Licence |
|---|---|---|---|
| `anthropic-symbolic.svg` | Claude | [Simple Icons](https://github.com/simple-icons/simple-icons) `claude` | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `openai-symbolic.svg` | OpenAI (Codex) | Simple Icons `openai` | CC0-1.0 |
| `deepseek-symbolic.svg` | DeepSeek | Simple Icons `deepseek` | CC0-1.0 |
| `kimi-symbolic.svg` | Kimi | Simple Icons `kimi` | CC0-1.0 |
| `openrouter-symbolic.svg` | OpenRouter | Simple Icons `openrouter` | CC0-1.0 |
| `ollama-symbolic.svg` | Ollama Cloud | Simple Icons `ollama` (`fill="#ffffff"` added) | CC0-1.0 |
| `zai-symbolic.svg` | Z.AI / GLM | [lobe-icons](https://github.com/lobehub/lobe-icons) `zhipu` | [MIT](https://github.com/lobehub/lobe-icons/blob/master/LICENSE) |
| `ai-symbolic.svg` | Custom provider, generic fallback | Original to this project | Same as the extension |

The first six and `zai-symbolic.svg` are copied from the
[ai-usagebar](https://github.com/akitaonrails/ai-usagebar) GNOME extension's
`gnome-extension/icons/`, which took them from the sources above.
