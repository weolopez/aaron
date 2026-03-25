export default class AaronPage extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.innerHTML = `
      <style>
        .aaron-frame {
          min-height: calc(100vh - 12rem);
          border: 0;
        }
      </style>
      <main class="container pad-md">
        <section class="theme-base-bg border radius-md overflow-hidden">
          <iframe
            class="width-full aaron-frame"
            src="/aaron/agent-harness.html"
            title="Agent Harness"
            loading="lazy"
          ></iframe>
        </section>
      </main>
    `;
  }
}

if (!customElements.get("aaron-page")) {
  customElements.define("aaron-page", AaronPage);
}
