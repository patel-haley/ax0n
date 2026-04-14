// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const list = /** @type {HTMLUListElement} */ (document.getElementById("memory-list"));
  const emptyState = /** @type {HTMLParagraphElement} */ (document.getElementById("empty-state"));
  const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById("clear-btn"));
  const countEl = /** @type {HTMLSpanElement} */ (document.getElementById("memory-count"));

  /**
   * @typedef {{ id: string; content: string; file_path: string; timestamp: number }} Memory
   * @type {Memory[]}
   */
  let memories = [];

  /** @param {string} filePath */
  function sourceName(filePath) {
    if (filePath === "cursor-chat" || filePath === "codex-chat") {
      return filePath;
    }
    return filePath.split("/").pop() || filePath;
  }

  function render() {
    list.innerHTML = "";
    emptyState.style.display = memories.length === 0 ? "block" : "none";
    clearBtn.style.display = memories.length === 0 ? "none" : "inline-block";
    countEl.textContent = memories.length > 0 ? `${memories.length}` : "";

    memories.forEach((m) => {
      const li = document.createElement("li");
      li.className = "memory-item";
      li.dataset.id = m.id;

      const meta = document.createElement("div");
      meta.className = "memory-meta";

      const src = document.createElement("span");
      src.className = "memory-source";
      src.textContent = sourceName(m.file_path);

      const date = document.createElement("span");
      date.className = "memory-date";
      date.textContent = new Date(m.timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.title = "Delete this memory";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: "delete", id: m.id });
      });

      meta.appendChild(src);
      meta.appendChild(date);
      meta.appendChild(delBtn);

      const preview = document.createElement("p");
      preview.className = "memory-preview";
      preview.textContent = m.content.replace(/\s+/g, " ").slice(0, 160);

      li.appendChild(meta);
      li.appendChild(preview);
      list.appendChild(li);
    });
  }

  clearBtn.addEventListener("click", () => {
    vscode.postMessage({ command: "clearAll" });
  });

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const message = event.data;
    switch (message.command) {
      case "init":
      case "refresh":
        memories = message.memories ?? [];
        render();
        break;
      case "deleted":
        memories = memories.filter((m) => m.id !== message.id);
        render();
        break;
      case "cleared":
        memories = [];
        render();
        break;
    }
  });

  render();
})();
