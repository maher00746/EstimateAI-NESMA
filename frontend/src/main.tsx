import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Login from "./Login";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import "./style.css";

function Root() {
  const { isAuthenticated, isLoading, logout } = useAuth();

  useEffect(() => {
    const handleLogout = () => {
      logout();
    };

    window.addEventListener("auth:logout", handleLogout);
    return () => {
      window.removeEventListener("auth:logout", handleLogout);
    };
  }, [logout]);

  if (isLoading) {
    return (
      <div style={{ 
        display: "flex", 
        justifyContent: "center", 
        alignItems: "center", 
        height: "100vh",
        color: "#e3e9ff"
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ 
            width: "48px", 
            height: "48px", 
            border: "3px solid rgba(227,233,255,0.2)", 
            borderTop: "3px solid #4c6ef5",
            borderRadius: "50%",
            animation: "spin 1s linear infinite",
            margin: "0 auto 1rem"
          }}></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("app") as HTMLElement).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
);
