import { useState } from "react";
import { useAuth } from "./contexts/AuthContext";

function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isRegistering) {
        if (!username || !email || !password) {
          setError("All fields are required");
          setLoading(false);
          return;
        }
        if (password.length < 6) {
          setError("Password must be at least 6 characters long");
          setLoading(false);
          return;
        }
        await register(username, email, password);
      } else {
        if (!username || !password) {
          setError("Username and password are required");
          setLoading(false);
          return;
        }
        await login(username, password);
      }
    } catch (err) {
      setError((err as Error).message || "Authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-background">
        <div className="login-glow login-glow--1"></div>
        <div className="login-glow login-glow--2"></div>
        <div className="login-glow login-glow--3"></div>
      </div>
      
      <div className="login-card">
        <div className="login-card__header">
          <div className="login-logo">
            <img src="/logo.png" alt="Logo" className="login-logo__image" />
          </div>
          <h1 className="login-title">AI Powered Estimation System</h1>
          <p className="login-subtitle">Intelligent estimation management platform</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {isRegistering && (
            <div className="login-form__group">
              <label htmlFor="email" className="login-form__label">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <rect x="2" y="3" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M2 5l7 4 7-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Email
              </label>
              <input
                id="email"
                type="email"
                className="login-form__input"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus={isRegistering}
                disabled={loading}
              />
            </div>
          )}

          <div className="login-form__group">
            <label htmlFor="username" className="login-form__label">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
                <path d="M3 16c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Username
            </label>
            <input
              id="username"
              type="text"
              className="login-form__input"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus={!isRegistering}
              disabled={loading}
            />
          </div>

          <div className="login-form__group">
            <label htmlFor="password" className="login-form__label">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="4" y="8" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6 8V6a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Password
            </label>
            <input
              id="password"
              type="password"
              className="login-form__input"
              placeholder={isRegistering ? "At least 6 characters" : "Enter your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
          </div>

          {error && (
            <div style={{
              padding: "0.75rem",
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: "8px",
              color: "#ef4444",
              fontSize: "0.875rem",
              marginBottom: "1rem"
            }}>
              {error}
            </div>
          )}

          <button type="submit" className="login-form__submit" disabled={loading}>
            <span>{loading ? (isRegistering ? "Registering..." : "Signing in...") : (isRegistering ? "Register" : "Sign In")}</span>
            {!loading && (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M7 3l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          <div style={{ 
            marginTop: "1rem", 
            textAlign: "center",
            fontSize: "0.875rem",
            color: "rgba(227,233,255,0.7)"
          }}>
            {isRegistering ? (
              <span>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setIsRegistering(false);
                    setError("");
                    setEmail("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#4c6ef5",
                    cursor: "pointer",
                    textDecoration: "underline"
                  }}
                >
                  Sign in
                </button>
              </span>
            ) : (
              <span>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setIsRegistering(true);
                    setError("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#4c6ef5",
                    cursor: "pointer",
                    textDecoration: "underline"
                  }}
                >
                  Register
                </button>
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default Login;

