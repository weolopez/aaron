export default class AaronPage extends HTMLElement {
  static AVAILABLE_PAGES = [
    { file: "agent-harness.html", label: "Agent Harness" },
    { file: "skills.html", label: "Skills" },
    { file: "workflows.html", label: "Workflows" },
  ];

  constructor() {
    super();
  }

  connectedCallback() {
    this.render();
  }

  resolvePageSrc() {
    const params = new URLSearchParams(window.location.search);
    const requestedPage = (params.get("page") || "agent-harness.html").trim();

    const normalizedPage = requestedPage.replace(/^\/+/, "");
    const isHtmlFile = normalizedPage.toLowerCase().endsWith(".html");
    const hasTraversal = normalizedPage.includes("..") || normalizedPage.includes("\\");

    const safePage = isHtmlFile && !hasTraversal
      ? normalizedPage
      : "agent-harness.html";

    return `/aaron/${safePage}`;
  }

  resolvePageFile() {
    return this.resolvePageSrc().replace("/aaron/", "");
  }

  getPageHref(pageFile) {
    const params = new URLSearchParams(window.location.search);
    params.set("page", pageFile);
    return `?${params.toString()}`;
  }

  render() {
    const pageSrc = this.resolvePageSrc();
    const activePage = this.resolvePageFile();
    const linksMarkup = AaronPage.AVAILABLE_PAGES.map((page) => {
      const isActive = page.file === activePage;
      return `
        <a
          class="aaron-page-link${isActive ? " is-active" : ""}"
          href="${this.getPageHref(page.file)}"
          ${isActive ? 'aria-current="page"' : ""}
        >${page.label}</a>
      `;
    }).join("");

    this.innerHTML = `
      <style>
        .aaron-nav {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 0.75rem;
        }

        .aaron-page-link {
          text-decoration: none;
          padding: 0.375rem 0.625rem;
          border: 1px solid;
          border-radius: 0.375rem;
          font-weight: 500;
        }

        .aaron-page-link.is-active {
          text-decoration: underline;
        }

        .aaron-frame {
          min-height: calc(100vh - 12rem);
          border: 0;
        }
      </style>
      <main class="container pad-md">
        <nav class="aaron-nav" aria-label="Aaron pages">
          ${linksMarkup}
        </nav>
        <section class="theme-base-bg border radius-md overflow-hidden">
          <iframe
            class="width-full aaron-frame"
            src="${pageSrc}"
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
