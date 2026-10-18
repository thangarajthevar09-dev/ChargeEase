document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("reg");
  const msg = document.getElementById("msg");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    msg.className = "form-msg";
    msg.textContent = "Creating account…";
    try {
      await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      msg.className = "form-msg success";
      msg.textContent = "Account created. Redirecting to sign in…";
      setTimeout(() => location.href = "/login.html", 900);
    } catch (error) {
      msg.className = "form-msg error";
      msg.textContent = error.message;
    }
  });
});
