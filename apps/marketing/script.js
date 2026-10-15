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

const stages = {
  plan: {
    banner:
      "<b>One issue, a clear shared contract.</b> Validate the split before work begins.",
    columns: [
      {
        title: "PLAN",
        type: "plan",
        id: "SS-041",
        name: "Define checkout contract",
        path: "shared/checkout.ts",
        status: "Contract first",
        owner: "AL",
        color: "lavender",
      },
      {
        title: "PROPOSED",
        type: "building",
        id: "SS-042",
        name: "Build the checkout API",
        path: "src/api/checkout/**",
        status: "Scope validated",
        owner: "AL",
        color: "lavender",
      },
      {
        title: "PROPOSED",
        type: "verify",
        id: "SS-043",
        name: "Design the checkout UI",
        path: "src/ui/checkout/**",
        status: "Scope validated",
        owner: "JM",
        color: "peach",
      },
    ],
    activity:
      "The validator checks file overlap, dependencies, and acceptance commands.",
    description: "Shared interfaces first. Clear, testable tasks second.",
  },
  build: {
    banner:
      "<b>Shared contract, locked in.</b> Every agent builds against the same types.",
    columns: [
      {
        title: "BUILDING",
        type: "building",
        id: "SS-042",
        name: "Build the checkout API",
        path: "src/api/checkout/**",
        status: "Files leased",
        owner: "AL",
        color: "lavender",
      },
      {
        title: "BUILDING",
        type: "building",
        id: "SS-043",
        name: "Design the checkout UI",
        path: "src/ui/checkout/**",
        status: "Files leased",
        owner: "JM",
        color: "peach",
        highlight: true,
      },
      {
        title: "VERIFY",
        type: "verify",
        id: "SS-044",
        name: "Cover the payment flow",
        path: "tests/checkout/**",
        status: "Checks passing",
        owner: "SK",
        color: "mint",
      },
    ],
    activity: "Jamie’s Claude is building within its assigned files.",
    description: "Separate file ownership keeps parallel work coordinated.",
  },
  verify: {
    banner:
      "<b>The pieces work. Do they work together?</b> Run the assembled application.",
    columns: [
      {
        title: "BUILT",
        type: "building",
        id: "SS-042 + 043",
        name: "API and interface assembled",
        path: "session/checkout",
        status: "Tasks passed",
        owner: "AL",
        color: "lavender",
      },
      {
        title: "VERIFY",
        type: "verify",
        id: "SS-044",
        name: "Test the complete checkout",
        path: "Assembled app",
        status: "Run, inspect, fix",
        owner: "SK",
        color: "mint",
        highlight: true,
      },
      {
        title: "REVIEW",
        type: "plan",
        id: "INTEGRATION PR",
        name: "Checkout, ready for the team",
        path: "/ss:ship",
        status: "After verification",
        owner: "JM",
        color: "peach",
      },
    ],
    activity:
      "If verification fails, affected tasks reopen. Fix, assemble, and run again.",
    description: "Verified together before the final integration PR.",
  },
};
const tabs = [...document.querySelectorAll("[data-stage]")];
function selectStage(stage, focus = false) {
  const data = stages[stage];
  if (!data) return;
  tabs.forEach((tab) => {
    const selected = tab.dataset.stage === stage;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  document
    .querySelector("#demo-panel")
    .setAttribute("aria-labelledby", `tab-${stage}`);
  document.querySelector("#board-banner").innerHTML = data.banner;
  document.querySelector("#board-columns").innerHTML = data.columns
    .map(
      (card) =>
        `<div class="board-column"><div class="column-title ${card.type}"><span class="col-dot"></span>${card.title}<span>01</span></div><article class="task-card ${card.highlight ? "highlight" : ""}"><div class="task-id"><span>${card.id}</span><span>···</span></div><h4>${card.name}</h4><span class="task-path">${card.path}</span><div class="task-footer"><span>⌑ ${card.status}</span><span><span class="avatar ${card.color}">${card.owner}</span> + Claude</span></div></article></div>`,
    )
    .join("");
  document.querySelector("#activity-text").textContent = data.activity;
  document.querySelector("#stage-description").textContent = data.description;
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectStage(tab.dataset.stage));
  tab.addEventListener("keydown", (event) => {
    let target;
    if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      target = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = tabs.length - 1;
    if (target !== undefined) {
      event.preventDefault();
      selectStage(tabs[target].dataset.stage, true);
    }
  });
});
selectStage("build");
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
