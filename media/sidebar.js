// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const list = /** @type {HTMLUListElement} */ (document.getElementById("capture-list"));
  const emptyState = /** @type {HTMLParagraphElement} */ (document.getElementById("empty-state"));
  const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById("clear-btn"));

  /** @type {{ text: string; source: string }[]} */
  let captures = [];

  function render() {
    list.innerHTML = "";
    emptyState.style.display = captures.length === 0 ? "block" : "none";

    captures.forEach(({ text, source }) => {
      const li = document.createElement("li");
      li.className = "capture-item";

      const src = document.createElement("div");
      src.className = "capture-source";
      src.textContent = source;

      const pre = document.createElement("pre");
      pre.className = "capture-text";
      pre.textContent = text;

      li.appendChild(src);
      li.appendChild(pre);
      list.prepend(li); // newest at the top
    });
  }

  clearBtn.addEventListener("click", () => {
    captures = [];
    render();
    vscode.postMessage({ command: "clear" });
  });

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const message = event.data;
    switch (message.command) {
      case "capture":
        captures.push({ text: message.text, source: message.source });
        render();
        break;
      case "clear":
        captures = [];
        render();
        break;
    }
  });

  // Initial render
  render();
})();
