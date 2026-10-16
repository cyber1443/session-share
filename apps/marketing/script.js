/**
 * The hosted Cloud's address. Empty until it is live: the Cloud buttons then
 * point at the install steps and the login line shows a placeholder.
 */
const CLOUD_URL = "https://claudeshare.space";

if (CLOUD_URL) {
  document.querySelectorAll("[data-cloud-link]").forEach((link) => {
    link.href = CLOUD_URL + link.dataset.cloudLink;
  });
  document.querySelectorAll("[data-cloud-command]").forEach((code) => {
    code.textContent = "/ss:login " + CLOUD_URL;
  });
}

const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#navigation");
function closeMenu() {
  menuButton.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
}
menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("open", open);
});
navigation
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navigation.classList.contains("open")) {
    closeMenu();
    menuButton.focus();
  }
});
const integrations = {
  jira: {
    title: "Jira → shared mission",
    description:
      "Bring the context from your team’s backlog directly into a collaborative coding session.",
    features: [
      "Import a Jira issue as the starting point for a session",
      "Keep the source ticket linked to the implementation",
      "Reflect session progress back on the issue",
    ],
  },
  slack: {
    title: "Less chasing. More context.",
    description:
      "Bring meaningful session updates to the Slack channels where your team already works.",
    features: [
      "Share session milestones in a selected channel",
      "Surface blockers and handoff requests",
      "Notify the team when work is ready for review",
    ],
  },
  linear: {
    title: "From issue to implementation.",
    description:
      "Connect focused issue tracking with the developers and agents doing the work.",
    features: [
      "Start a session from a Linear issue",
      "Keep the implementation linked to its original context",
      "Share progress and review status back to Linear",
    ],
  },
};
const dialog = document.querySelector("#roadmap-dialog");
document.querySelectorAll("[data-integration]").forEach((button) =>
  button.addEventListener("click", () => {
    const integration = integrations[button.dataset.integration];
    document.querySelector("#dialog-title").textContent = integration.title;
    document.querySelector("#dialog-description").textContent =
      integration.description;
    document.querySelector("#dialog-features").replaceChildren(
      ...integration.features.map((feature) => {
        const item = document.createElement("li");
        item.textContent = feature;
        return item;
      }),
    );
    dialog.showModal();
  }),
);
document
  .querySelector(".dialog-close")
  .addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  }
});
let toastTimeout;
function toast(message) {
  const el = document.querySelector(".toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("visible"), 4500);
}
document
  .querySelector('[data-copy="install"]')
  .addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(
        "/plugin marketplace add cyber1443/session-share\n/plugin install ss@session-share",
      );
      button.textContent = "Copied ✓";
      toast("Commands copied. Paste them into Claude Code.");
      setTimeout(() => {
        button.textContent = "Copy commands ▢";
      }, 2500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".install-code"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast("Select and copy the commands above to continue.");
    }
  });
document.querySelector("#year").textContent = new Date().getFullYear();
