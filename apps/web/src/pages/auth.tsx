/**
 * Hub auth for a *hosted* hub: sign up or sign in against it directly.
 *
 * A local desktop never reaches this form — its owner mints automatically
 * (`apps/web/src/app.tsx`'s `mintOwner`, `apps/hub/src/hub-client.ts`'s
 * `mintOwnerSetCookie`), because it is a single-user machine with a keychain
 * to hold the password in. A hosted hub has neither: there is no one local
 * owner and no user keychain to mint into, so a real account is the honest
 * thing to ask for. If minting failed instead of a hosted hub existing —
 * the keychain could not be read, or the hub refused the minted account —
 * `mintFailure` is set and this shows that reason plainly, with a retry,
 * never a credentials form: there is nothing else to type on a desktop with
 * one owner.
 */
import { Input } from "@corbits/react-ui";
import { ApiError } from "@intx/hub-client";
import { useState } from "react";
import { Banner, Button, Mark } from "../components.jsx";
import { signInHub, signUpHub } from "../hub-auth.ts";

type Mode = "signup" | "login";

const PASSWORD_MIN = 8;

export type MintFailure = { reason: string; onRetry: () => void };

export function Auth({
  onSignedIn,
  mintFailure,
}: {
  onSignedIn: () => void;
  mintFailure?: MintFailure;
}) {
  if (mintFailure) return <MintFailureCard failure={mintFailure} />;
  return <HostedAuth onSignedIn={onSignedIn} />;
}

function MintFailureCard({ failure }: { failure: MintFailure }) {
  return (
    <div className="onboarding">
      <div className="onboarding-brand">
        <Mark size={26} />
        <strong>Solutions Builder</strong>
      </div>

      <div className="onboarding-card">
        <h1>Could not sign you in.</h1>
        <p className="lede">This workspace lives on your machine, so there is nothing to type.</p>
        <Banner tone="error" title={failure.reason} />
        <Button variant="primary" block onClick={failure.onRetry}>
          Try again
        </Button>
      </div>

      <p className="onboarding-foot">
        <Mark size={14} />
        <span>Powered by Corbits</span>
      </p>
    </div>
  );
}

function HostedAuth({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = email.includes("@") && email.trim().length > 2;
  const passwordOk = password.length >= PASSWORD_MIN;
  const nameOk = mode === "login" || name.trim().length > 0;
  const canSubmit = emailOk && passwordOk && nameOk && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await signUpHub({ email: email.trim(), password, name: name.trim() });
      } else {
        await signInHub({ email: email.trim(), password });
      }
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-brand">
        <Mark size={26} />
        <strong>Solutions Builder</strong>
      </div>

      <div className="onboarding-card">
        <h1>{mode === "signup" ? "Create your account." : "Welcome back."}</h1>
        <p className="lede">
          {mode === "signup"
            ? "Create the account that owns this workspace."
            : "Sign in with the account that owns this workspace."}
        </p>

        {error ? <Banner tone="error" title={error} /> : null}

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === "signup" ? (
            <label className="field">
              <span>Name</span>
              <Input
                autoComplete="name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
          ) : null}
          <label className="field">
            <span>Email</span>
            <Input
              type="email"
              autoComplete="email"
              autoFocus={mode === "login"}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <Input
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <Button variant="primary" block type="submit" loading={busy} disabled={!canSubmit}>
            {mode === "signup" ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="auth-switch">
          {mode === "signup" ? (
            <>
              Already have an account?{" "}
              <Button
                variant="link"
                disabled={busy}
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
              >
                Sign in
              </Button>
            </>
          ) : (
            <>
              No account yet?{" "}
              <Button
                variant="link"
                disabled={busy}
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
              >
                Create an account
              </Button>
            </>
          )}
        </p>
      </div>

      <p className="onboarding-foot">
        <Mark size={14} />
        <span>Powered by Corbits</span>
      </p>
    </div>
  );
}
