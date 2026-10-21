function togglePassword() {
  const input = document.getElementById("password");
  const button = document.querySelector(".eye");
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  if (button) button.textContent = input.type === "password" ? "Show" : "Hide";
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login");
  const msg = document.getElementById("msg");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    msg.className = "form-msg";
    msg.textContent = "Signing in…";
    try {
      const data = await api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      msg.className = "form-msg success";
      msg.textContent = "Login successful. Redirecting…";
      const routes = {
        ADMIN: "/admin.html",
        STATION_OWNER: "/owner.html",
        USER: "/user.html"
      };
      location.href = routes[data.user.role] || "/user.html";
    } catch (error) {
      msg.className = "form-msg error";
      msg.textContent = error.message;
    }
  });
});
