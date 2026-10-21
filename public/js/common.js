async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function money(value) {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function dateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toast(message, type = "") {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const node = document.createElement("div");
  node.className = `toast ${type}`;

  let icon = "⚡";
  if (type === "success") icon = "✓";
  else if (type === "error") icon = "✕";

  node.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${esc(message)}</span>
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>
  `;

  node.querySelector(".toast-close")?.addEventListener("click", () => {
    node.remove();
  });

  container.appendChild(node);

  setTimeout(() => {
    node.classList.add("toast-hiding");
    setTimeout(() => node.remove(), 260);
  }, 3400);
}

async function logout() {
  try { await api("/api/logout", { method: "POST" }); } catch (_) {}
  location.href = "/";
}

async function currentSession() {
  return api("/api/session");
}

function initials(name, fallback = "U") {
  const value = String(name || fallback).trim();
  return value ? value.charAt(0).toUpperCase() : fallback;
}

function statusClass(status) {
  return String(status || "").toUpperCase().replace(/[^A-Z_]/g, "");
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function showModal(html) {
  closeModal();
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = html;

  // Light dismiss: click outside modal card closes modal
  modal.addEventListener("click", event => {
    if (event.target === modal) closeModal();
  });

  document.body.appendChild(modal);
  document.body.classList.add("modal-open");
  return modal;
}

function closeModal() {
  document.querySelectorAll(".modal").forEach(node => node.remove());
  document.body.classList.remove("modal-open");
}

// Global escape key listener to close modals
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeModal();
  }
});
