# Cortex Memory

At the start of every session, call `search_memories` with a query derived from the user's first message. If relevant memories are returned, use them to inform your response.

After every substantive response — an implementation, explanation of a fix, test plan, or diagnosis — call `save_memory` with a 2-3 sentence summary written from your perspective. The summary must include what the problem was, what approach or fix you used and why, and any non-obvious detail that would matter if this came up again. Use `file_path: "codex-chat"`. Only save your own responses, not the user's questions.
