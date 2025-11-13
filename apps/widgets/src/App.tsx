import { useState } from "react";
import clsx from "clsx";

declare global {
  interface Window {
    __OPENFINANCE_API_BASE__?: string;
  }
}

const DEFAULT_BASE = "http://localhost:1411";

const runtimeBase =
  typeof window !== "undefined" ? window.__OPENFINANCE_API_BASE__ : undefined;

// If the runtime base is localhost but we're being served from a remote origin,
// use the current origin instead (for ngrok/tunnel scenarios)
function getEffectiveApiBase(): string {
  const base = import.meta.env.VITE_STARTER_KIT_BASE_URL ?? runtimeBase ?? DEFAULT_BASE;
  
  if (typeof window !== "undefined") {
    const currentOrigin = window.location.origin;
    // If we're on a remote origin (not localhost) but base is localhost, use current origin
    if (!currentOrigin.includes("localhost") && base.includes("localhost")) {
      console.info("[Widget] Detected remote origin, using:", currentOrigin);
      return currentOrigin;
    }
  }
  
  return base;
}

const API_BASE = getEffectiveApiBase().replace(/\/$/, "");

type StepStatus = "idle" | "loading" | "success" | "error" | "ready";

type ConsentResponse = {
  redirect: string;
  consent_id: string;
  code_verifier: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type DataEndpoint = {
  id: string;
  label: string;
  path: string;
  description: string;
};

const dataEndpoints: DataEndpoint[] = [
  {
    id: "accounts",
    label: "Accounts List",
    path: "/open-finance/account-information/v1.2/accounts",
    description: "Get all authorized accounts",
  },
  {
    id: "balances",
    label: "Account Balances",
    path: "/open-finance/account-information/v1.2/accounts/{accountId}/balances",
    description: "Get balance for a specific account",
  },
  {
    id: "transactions",
    label: "Transactions",
    path: "/open-finance/account-information/v1.2/accounts/{accountId}/transactions",
    description: "Get transaction history",
  },
  {
    id: "beneficiaries",
    label: "Beneficiaries",
    path: "/open-finance/account-information/v1.2/accounts/{accountId}/beneficiaries",
    description: "Get saved beneficiaries",
  },
  {
    id: "standing-orders",
    label: "Standing Orders",
    path: "/open-finance/account-information/v1.2/accounts/{accountId}/standing-orders",
    description: "Get recurring payments",
  },
  {
    id: "direct-debits",
    label: "Direct Debits",
    path: "/open-finance/account-information/v1.2/accounts/{accountId}/direct-debits",
    description: "Get direct debit mandates",
  },
];

const bankOptions = [
  "Model Bank (Demo)",
  "Noor Digital Sandbox",
  "Al Etihad Test Bank",
  "Sandbox Credit Union",
];

const dataPermissionOptions = [
  "ReadAccountsBasic",
  "ReadAccountsDetail",
  "ReadBalances",
  "ReadBeneficiariesBasic",
  "ReadBeneficiariesDetail",
  "ReadTransactionsBasic",
  "ReadTransactionsDetail",
  "ReadTransactionsCredits",
  "ReadTransactionsDebits",
  "ReadScheduledPaymentsBasic",
  "ReadScheduledPaymentsDetail",
  "ReadDirectDebits",
  "ReadStandingOrdersBasic",
  "ReadStandingOrdersDetail",
  "ReadConsents",
  "ReadPartyUser",
  "ReadPartyUserIdentity",
  "ReadParty",
];

async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("ngrok-skip-browser-warning", "true");
  headers.set("bypass-tunnel-reminder", "true");
  headers.set("localtunnel-bypass", "true");
  const hasBody =
    typeof init.body !== "undefined" && init.body !== null ? true : false;
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch (networkError) {
    const detail =
      networkError instanceof Error
        ? `${networkError.name}: ${networkError.message}`
        : String(networkError);
    throw new Error(
      `Network error calling ${path} at ${API_BASE}: ${detail}. ` +
        "ChatGPT must be able to reach your Starter Kit server (e.g. via port forwarding or a tunnel)."
    );
  }

  const raw = await response.text();
  let data: any = null;

  if (raw && raw.length) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      data = raw;
    }
  }

  if (!response.ok) {
    const reason =
      typeof data === "string"
        ? data
        : data?.description ||
          data?.error ||
          data?.message ||
          response.statusText;
    throw new Error(
      `HTTP ${response.status} ${response.statusText} on ${path}: ${reason}`
    );
  }

  return data as T;
}

const statusLabel: Record<StepStatus, string> = {
  idle: "Not Started",
  loading: "Processing...",
  success: "✓ Complete",
  error: "✗ Failed",
  ready: "Ready",
};

function StatusBadge({ status }: { status: StepStatus }) {
  return (
    <span
      className={clsx(
        "status-badge",
        status === "success" && "status-success",
        status === "loading" && "status-loading",
        status === "error" && "status-error",
        status === "ready" && "status-ready"
      )}
    >
      {statusLabel[status]}
    </span>
  );
}

export default function App() {
  // Current step (1-5)
  const [currentStep, setCurrentStep] = useState(1);

  // Step 1: Consent Configuration
  const [selectedBank, setSelectedBank] = useState("Model Bank (Demo)");
  const [dataPermissions, setDataPermissions] = useState<string[]>([
    "ReadAccountsBasic",
    "ReadAccountsDetail",
    "ReadBalances",
    "ReadTransactionsBasic",
  ]);
  const [step1Status, setStep1Status] = useState<StepStatus>("idle");

  // Step 2: Consent Creation (background)
  const [consentData, setConsentData] = useState<ConsentResponse | null>(null);
  const [step2Status, setStep2Status] = useState<StepStatus>("idle");

  // Step 3: Bank Authentication
  const [step3Status, setStep3Status] = useState<StepStatus>("idle");

  // Step 4: Token Exchange
  const [callbackUrl, setCallbackUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [step4Status, setStep4Status] = useState<StepStatus>("idle");

  // Step 5: Data Fetching
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [fetchedData, setFetchedData] = useState<any>(null);
  const [accountsList, setAccountsList] = useState<any[]>([]);
  const [step5Status, setStep5Status] = useState<StepStatus>("idle");

  // Messages
  const [messages, setMessages] = useState<string[]>([]);

  const recordMessage = (message: string) => {
    setMessages((prev) => [
      `${new Date().toLocaleTimeString()}: ${message}`,
      ...prev,
    ]);
  };

  const toggleDataPermission = (permission: string) => {
    setDataPermissions((current) =>
      current.includes(permission)
        ? current.filter((value) => value !== permission)
        : [...current, permission]
    );
  };

  // Step 1: Confirm consent parameters
  const handleConfirmConsent = () => {
    if (!selectedBank) {
      recordMessage("Please select a bank");
      return;
    }
    if (dataPermissions.length === 0) {
      recordMessage("Please select at least one data permission");
      return;
    }
    setStep1Status("success");
    setCurrentStep(2);
    recordMessage(`Consent parameters confirmed for ${selectedBank}`);
    // Automatically proceed to Step 2
    handleCreateConsent();
  };

  // Step 2: Create consent (background - PAR, JWT, etc.)
  const handleCreateConsent = async () => {
    setStep2Status("loading");
    recordMessage("Creating consent in background (PAR + JWT)...");

    try {
      const now = new Date();
      const validUntil = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

      const payload = await apiRequest<ConsentResponse>(
        "/consent-create/bank-data",
        {
          method: "POST",
          body: JSON.stringify({
            bank_label: selectedBank,
            data_permissions: dataPermissions,
            valid_from: now.toISOString(),
            valid_until: validUntil.toISOString(),
          }),
        }
      );

      setConsentData(payload);
      setStep2Status("success");
      setStep3Status("ready");
      setCurrentStep(3);
      recordMessage("Consent created successfully! Redirect URL ready.");
    } catch (error) {
      setStep2Status("error");
      recordMessage(`Consent creation failed: ${(error as Error).message}`);
    }
  };

  // Step 3: Open bank authentication
  const handleOpenBank = () => {
    if (!consentData?.redirect) {
      recordMessage("No redirect URL available");
      return;
    }
    window.open(consentData.redirect, "_blank", "noopener,noreferrer");
    setStep3Status("success");
    setStep4Status("ready");
    setCurrentStep(4);
    recordMessage("Opened bank authentication in new tab");
  };

  // Step 4: Parse callback URL and exchange for token
  const handleExchangeToken = async () => {
    if (!callbackUrl.trim()) {
      recordMessage("Please paste the callback URL");
      return;
    }

    setStep4Status("loading");
    recordMessage("Extracting authorization code from callback URL...");

    try {
      // Parse the callback URL to extract the code
      const url = new URL(callbackUrl);
      const code = url.searchParams.get("code");

      if (!code) {
        throw new Error("No authorization code found in callback URL");
      }

      if (!consentData?.code_verifier) {
        throw new Error("No code verifier available");
      }

      recordMessage(`Authorization code extracted: ${code.substring(0, 10)}...`);

      // Exchange code for token
      const tokenPayload = await apiRequest<TokenResponse>(
        "/token/authorization-code",
        {
          method: "POST",
          body: JSON.stringify({
            code: code,
            code_verifier: consentData.code_verifier,
          }),
        }
      );

      setAccessToken(tokenPayload.access_token);
      setStep4Status("success");
      setStep5Status("ready");
      setCurrentStep(5);
      recordMessage("Access token obtained successfully!");
    } catch (error) {
      setStep4Status("error");
      recordMessage(`Token exchange failed: ${(error as Error).message}`);
    }
  };

  // Step 5: Fetch data from selected endpoint
  const handleFetchData = async (endpoint: DataEndpoint) => {
    if (!accessToken) {
      recordMessage("No access token available");
      return;
    }

    setSelectedEndpoint(endpoint.id);
    setStep5Status("loading");
    recordMessage(`Fetching ${endpoint.label}...`);

    try {
      let path = endpoint.path;

      // If endpoint requires accountId, substitute it
      if (path.includes("{accountId}")) {
        if (endpoint.id === "balances" && accountsList.length === 0) {
          // First fetch accounts list
          recordMessage("Fetching accounts list first...");
          const accountsData = await apiRequest<any>(
            "/open-finance/account-information/v1.2/accounts",
            {
              method: "GET",
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          const accounts = accountsData?.Data?.Account ?? [];
          setAccountsList(accounts);
          
          if (accounts.length === 0) {
            throw new Error("No accounts found");
          }

          // Use first account
          const firstAccountId = accounts[0]?.AccountId ?? accounts[0]?.account_id;
          if (!firstAccountId) {
            throw new Error("Could not extract account ID");
          }
          
          path = path.replace("{accountId}", firstAccountId);
          setAccountId(firstAccountId);
          recordMessage(`Using account: ${firstAccountId}`);
        } else if (accountId) {
          path = path.replace("{accountId}", accountId);
        } else {
          throw new Error("Account ID required for this endpoint");
        }
      }

      const data = await apiRequest<any>(path, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      setFetchedData(data);
      setStep5Status("success");
      recordMessage(`${endpoint.label} fetched successfully!`);
    } catch (error) {
      setStep5Status("error");
      recordMessage(`Data fetch failed: ${(error as Error).message}`);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header compact">
        <div>
          <h1>Open Finance Data Sharing</h1>
          <p className="lede">
            Follow the 5-step process to share bank data through the AlTareq
            Model Bank
          </p>
        </div>
        <div className="step-indicator">
          <span>Step {currentStep} of 5</span>
        </div>
      </header>

      {/* Progress Tracker */}
      <div className="progress-tracker">
        <div className={clsx("progress-step", currentStep >= 1 && "active")}>
          <div className="step-number">1</div>
          <div className="step-label">
            <strong>Confirm Consent</strong>
            <StatusBadge status={step1Status} />
          </div>
        </div>
        <div className={clsx("progress-step", currentStep >= 2 && "active")}>
          <div className="step-number">2</div>
          <div className="step-label">
            <strong>Create Consent</strong>
            <StatusBadge status={step2Status} />
          </div>
        </div>
        <div className={clsx("progress-step", currentStep >= 3 && "active")}>
          <div className="step-number">3</div>
          <div className="step-label">
            <strong>Authenticate</strong>
            <StatusBadge status={step3Status} />
          </div>
        </div>
        <div className={clsx("progress-step", currentStep >= 4 && "active")}>
          <div className="step-number">4</div>
          <div className="step-label">
            <strong>Get Token</strong>
            <StatusBadge status={step4Status} />
          </div>
        </div>
        <div className={clsx("progress-step", currentStep >= 5 && "active")}>
          <div className="step-number">5</div>
          <div className="step-label">
            <strong>Fetch Data</strong>
            <StatusBadge status={step5Status} />
          </div>
        </div>
      </div>

      {/* Step 1: Consent Configuration */}
      {currentStep === 1 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Step 1: Configure Data Sharing Consent</h2>
            <p>Select the bank and permissions you want to request</p>
          </div>

          <label className="field">
            <span>Select Bank</span>
            <select
              value={selectedBank}
              onChange={(e) => setSelectedBank(e.target.value)}
            >
              {bankOptions.map((bank) => (
                <option key={bank} value={bank}>
                  {bank}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Data Permissions</span>
            <p className="info-text">
              Select the data you want to access from the user's account
            </p>
            <div className="permission-grid compact">
              {dataPermissionOptions.map((permission) => {
                const selected = dataPermissions.includes(permission);
                return (
                  <label
                    key={permission}
                    className={clsx(
                      "permission-chip",
                      selected && "permission-chip-selected"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleDataPermission(permission)}
                    />
                    <span>{permission}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <button className="primary large" onClick={handleConfirmConsent}>
            Confirm and Create Consent →
          </button>
        </section>
      )}

      {/* Step 2: Consent Creation (shown briefly) */}
      {currentStep === 2 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Step 2: Creating Consent</h2>
            <p>
              Preparing authorization request (PAR + JWT signing in background)
            </p>
          </div>
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Processing consent creation...</p>
            {step2Status === "error" && (
              <button className="ghost" onClick={handleCreateConsent}>
                Retry
              </button>
            )}
          </div>
        </section>
      )}

      {/* Step 3: Authenticate at Bank */}
      {currentStep === 3 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Step 3: Authenticate at {selectedBank}</h2>
            <p>Click the button below to open the bank authentication page</p>
          </div>

          {consentData?.redirect && (
            <>
              <div className="info-box">
                <p>
                  <strong>What happens next:</strong>
                </p>
                <ol>
                  <li>You'll be redirected to {selectedBank}</li>
                  <li>Sign in with your test credentials</li>
                  <li>Select accounts to share</li>
                  <li>Authorize the consent</li>
                  <li>Copy the callback URL from your browser</li>
                </ol>
              </div>

              <button className="primary large" onClick={handleOpenBank}>
                Open {selectedBank} →
              </button>

              <details className="technical-details">
                <summary>Show redirect URL</summary>
                <code className="url-display">{consentData.redirect}</code>
              </details>
            </>
          )}
        </section>
      )}

      {/* Step 4: Paste Callback URL */}
      {currentStep === 4 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Step 4: Paste Callback URL</h2>
            <p>
              After authorizing at the bank, copy the entire callback URL from
              your browser
            </p>
          </div>

          <div className="info-box">
            <p>
              <strong>Where to find the callback URL:</strong>
            </p>
            <p>
              After authorizing at {selectedBank}, you'll be redirected to a URL
              like:
            </p>
            <code className="url-example">
              http://localhost:1411/hackathon-redirect?code=xxxxx&state=xxxxx&iss=xxxxx
            </code>
            <p>Copy the entire URL from your browser's address bar and paste it below.</p>
          </div>

          <label className="field">
            <span>Callback URL</span>
            <input
              type="text"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://localhost:1411/hackathon-redirect?code=..."
              className="url-input"
            />
          </label>

          <button
            className="primary large"
            onClick={handleExchangeToken}
            disabled={step4Status === "loading" || !callbackUrl.trim()}
          >
            {step4Status === "loading" ? "Exchanging..." : "Get Access Token →"}
          </button>

          {step4Status === "error" && (
            <p className="error-text">
              Failed to exchange token. Make sure you pasted the complete
              callback URL.
            </p>
          )}
        </section>
      )}

      {/* Step 5: Fetch Data */}
      {currentStep === 5 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Step 5: Fetch Account Data</h2>
            <p>Click on any data type below to fetch it from the bank</p>
          </div>

          {accessToken && (
            <div className="info-box success">
              <p>
                ✓ Access token obtained: {accessToken.substring(0, 10)}...
                {accessToken.substring(accessToken.length - 4)}
              </p>
            </div>
          )}

          <div className="data-endpoints">
            {dataEndpoints.map((endpoint) => (
              <button
                key={endpoint.id}
                className={clsx(
                  "endpoint-card",
                  selectedEndpoint === endpoint.id && "active"
                )}
                onClick={() => handleFetchData(endpoint)}
                disabled={step5Status === "loading"}
              >
                <div className="endpoint-label">{endpoint.label}</div>
                <div className="endpoint-description">
                  {endpoint.description}
                </div>
              </button>
            ))}
          </div>

          {step5Status === "loading" && (
            <div className="loading-state inline">
              <div className="spinner small"></div>
              <span>Fetching data...</span>
            </div>
          )}

          {fetchedData && (
            <div className="data-display">
              <div className="data-header">
                <h3>Response Data</h3>
                <button
                  className="ghost small"
                  onClick={() => {
                    setFetchedData(null);
                    setSelectedEndpoint(null);
                    setStep5Status("ready");
                  }}
                >
                  Clear
                </button>
              </div>
              <pre className="payload">{JSON.stringify(fetchedData, null, 2)}</pre>
            </div>
          )}
        </section>
      )}

      {/* Activity Log */}
      <section className="panel wide">
        <div className="panel-head">
          <h3>Activity Log</h3>
        </div>
        {messages.length === 0 ? (
          <p className="lede muted">No activity yet.</p>
        ) : (
          <ul className="log">
            {messages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
