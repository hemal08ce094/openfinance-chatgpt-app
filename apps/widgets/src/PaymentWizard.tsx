import { useState } from "react";
import { apiRequest } from "./lib/apiClient";

type PaymentConsentResponse = {
  redirect: string;
  consent_id: string;
  code_verifier: string;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

type PaymentResponse = {
  paymentId: string;
  status: string;
  amount: string;
  currency: string;
  jwt: string;
};

export default function PaymentWizard() {
  // Flow state: "input" | "redirect" | "success"
  const [flowState, setFlowState] = useState<"input" | "redirect" | "success">("input");
  
  // Payment data
  const [paymentAmount, setPaymentAmount] = useState("100.00");
  const [consentData, setConsentData] = useState<PaymentConsentResponse | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [paymentResult, setPaymentResult] = useState<PaymentResponse | null>(null);
  
  // UI state
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);

  const recordMessage = (message: string) => {
    setMessages((prev) => [
      `${new Date().toLocaleTimeString()}: ${message}`,
      ...prev,
    ]);
  };

  const isValidAmount = (value: string) =>
    /^(?:0|[1-9]\d*)(\.\d{2})$/.test(value.trim());

  // Handle payment initiation - creates consent and opens bank
  const handleInitiatePayment = async () => {
    if (!isValidAmount(paymentAmount)) {
      setError("Please enter a valid amount (e.g., 100.00)");
      return;
    }

    setIsProcessing(true);
    setError(null);
    recordMessage(`Initiating payment for ${paymentAmount} AED...`);

    try {
      // Create consent
      const payload = await apiRequest<PaymentConsentResponse>(
        "/consent-create/single-payment",
        {
          method: "POST",
          body: JSON.stringify({
            payment_amount: paymentAmount,
          }),
        }
      );

      setConsentData(payload);
      recordMessage("Payment consent created successfully");
      recordMessage("Opening bank authentication...");

      // Open bank redirect in new tab
      window.open(payload.redirect, "_blank", "noopener,noreferrer");
      
      // Move to redirect state
      setFlowState("redirect");
      setIsProcessing(false);
      recordMessage("Waiting for authorization...");
    } catch (err) {
      setIsProcessing(false);
      const errorMsg = (err as Error).message;
      setError(`Failed to create consent: ${errorMsg}`);
      recordMessage(`Error: ${errorMsg}`);
    }
  };

  // Handle callback URL submission - exchanges token and processes payment
  const handleSubmitCallback = async () => {
    if (!callbackUrl.trim()) {
      setError("Please paste the callback URL");
      return;
    }

    setIsProcessing(true);
    setError(null);
    recordMessage("Processing callback URL...");

    try {
      // Parse callback URL
      const url = new URL(callbackUrl);
      const directToken = url.searchParams.get("token");
      let token = directToken;

      if (!directToken) {
        // Standard OAuth flow - exchange code for token
        const code = url.searchParams.get("code");
        if (!code) {
          throw new Error("No authorization code or token found in callback URL");
        }

        if (!consentData?.code_verifier) {
          throw new Error("No code verifier available");
        }

        recordMessage("Exchanging authorization code for token...");
        const tokenPayload = await apiRequest<TokenResponse>(
          "/token/authorization-code",
          {
            method: "POST",
            body: JSON.stringify({
              code,
              code_verifier: consentData.code_verifier,
            }),
          }
        );
        token = tokenPayload.access_token;
      }

      if (!token) {
        throw new Error("Failed to obtain access token");
      }

      recordMessage("Access token obtained, initiating payment...");

      // Initiate payment
      const response = await apiRequest<any>(
        "/open-finance/payment/v1.2/payments",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            payment_amount: paymentAmount,
            consent_id: consentData!.consent_id,
          }),
        }
      );

      // Parse payment response
      let paymentId = "N/A";
      let status = "Pending";
      let responseText = "";

      if (typeof response === "string") {
        responseText = response;
        try {
          const parts = response.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            paymentId = payload.message?.Data?.PaymentId || paymentId;
            status = payload.message?.Data?.Status || status;
          }
        } catch {
          // Keep defaults
        }
      } else if (response.message?.Data) {
        paymentId = response.message.Data.PaymentId || paymentId;
        status = response.message.Data.Status || status;
        responseText = JSON.stringify(response, null, 2);
      } else if (response.Data) {
        paymentId = response.Data.PaymentId || paymentId;
        status = response.Data.Status || status;
        responseText = JSON.stringify(response, null, 2);
      } else {
        responseText = JSON.stringify(response, null, 2);
      }

      setPaymentResult({
        paymentId,
        status,
        amount: paymentAmount,
        currency: "AED",
        jwt: responseText,
      });

      setFlowState("success");
      setIsProcessing(false);
      recordMessage(`Payment successful! Payment ID: ${paymentId}`);
    } catch (err) {
      setIsProcessing(false);
      const errorMsg = (err as Error).message;
      setError(`Payment failed: ${errorMsg}`);
      recordMessage(`Error: ${errorMsg}`);
    }
  };

  // Reset to start over
  const handleReset = () => {
    setFlowState("input");
    setPaymentAmount("100.00");
    setConsentData(null);
    setCallbackUrl("");
    setPaymentResult(null);
    setError(null);
    setMessages([]);
  };

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header compact">
        <div className="raseed-brand">
          <span className="raseed-wordmark">PAYMENT</span>
        </div>
        <p className="lede">Send a secure payment through Open Finance</p>
      </header>

      {/* Main Content */}
      <section className="panel">
        {/* Input State - Enter Amount */}
        {flowState === "input" && (
          <div className="stage">
            <div className="stage-head">
              <h2>💸 Enter Payment Amount</h2>
              <p>Specify the amount you want to send in AED</p>
            </div>

            <div className="consent-preview">
              <label className="field">
                <span style={{ fontWeight: 600 }}>Amount (AED)</span>
                <input
                  type="text"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  placeholder="100.00"
                  className="amount-input"
                  style={{ fontSize: "2.5rem", textAlign: "center", padding: "20px" }}
                  autoFocus
                  disabled={isProcessing}
                />
                <p className="info-text" style={{ textAlign: "center", margin: "8px 0 0" }}>
                  Enter amount with two decimal places (e.g., 100.00)
                </p>
              </label>

              {error && (
                <div className="error-box" style={{ 
                  background: "#fee", 
                  border: "1px solid #fcc", 
                  borderRadius: "12px", 
                  padding: "12px",
                  color: "#c00"
                }}>
                  {error}
                </div>
              )}

              <button
                className="primary large consent-primary"
                onClick={handleInitiatePayment}
                disabled={isProcessing || !isValidAmount(paymentAmount)}
                style={{ marginTop: "16px" }}
              >
                {isProcessing ? "Creating Consent..." : `Continue with ${paymentAmount} AED →`}
              </button>

              <p className="consent-suptext">
                You'll be redirected to AlTareq Model Bank to authorize this payment
              </p>
            </div>
          </div>
        )}

        {/* Redirect State - Waiting for Authorization */}
        {flowState === "redirect" && (
          <div className="redirect-step">
            <div className="redirect-overlay">
              <div className="redirect-spinner"></div>
              <h2 style={{ margin: 0, fontSize: "1.5rem" }}>Authorize at Model Bank</h2>
              <p style={{ margin: 0, opacity: 0.9 }}>
                Complete authentication and authorization in the opened tab
              </p>
            </div>

            <div className="redirect-form">
              <h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>Paste Callback URL</h3>
              <p style={{ margin: "0 0 12px", fontSize: "0.875rem", color: "#5b6378" }}>
                After authorizing, copy the URL from your browser and paste it below:
              </p>

              <input
                type="text"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:1411/client/sip-success?..."
                className="url-input"
                style={{ 
                  width: "100%", 
                  padding: "10px", 
                  borderRadius: "8px",
                  border: "1px solid #ddd",
                  fontSize: "0.875rem",
                  marginBottom: "12px"
                }}
                disabled={isProcessing}
              />

              {error && (
                <div style={{ 
                  background: "#fee", 
                  border: "1px solid #fcc", 
                  borderRadius: "8px", 
                  padding: "8px",
                  color: "#c00",
                  fontSize: "0.875rem",
                  marginBottom: "12px"
                }}>
                  {error}
                </div>
              )}

              <button
                className="primary"
                onClick={handleSubmitCallback}
                disabled={isProcessing || !callbackUrl.trim()}
                style={{ width: "100%" }}
              >
                {isProcessing ? "Processing Payment..." : "Complete Payment →"}
              </button>

              <button
                className="ghost small"
                onClick={handleReset}
                disabled={isProcessing}
                style={{ width: "100%", marginTop: "8px" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Success State */}
        {flowState === "success" && paymentResult && (
          <div className="stage">
            <div className="success-icon" style={{ margin: "0 auto 24px" }}>✓</div>
            <div className="stage-head" style={{ textAlign: "center" }}>
              <h2 style={{ color: "#10b981", fontSize: "2rem" }}>Payment Successful!</h2>
              <p>Your payment has been initiated and is being processed</p>
            </div>

            <div className="consent-summary" style={{ marginTop: "24px" }}>
              <h3>Payment Details</h3>
              <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.8 }}>Amount:</span>
                  <strong style={{ fontSize: "1.25rem" }}>{paymentResult.amount} {paymentResult.currency}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.8 }}>Status:</span>
                  <span className="status-pending">{paymentResult.status}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ opacity: 0.8 }}>Payment ID:</span>
                  <code style={{ 
                    background: "rgba(255,255,255,0.1)", 
                    padding: "4px 8px", 
                    borderRadius: "6px",
                    fontSize: "0.75rem"
                  }}>
                    {paymentResult.paymentId}
                  </code>
                </div>
              </div>
            </div>

            <button
              className="primary large consent-primary"
              onClick={handleReset}
              style={{ marginTop: "24px" }}
            >
              Make Another Payment
            </button>

            {paymentResult.jwt && (
              <details style={{ marginTop: "16px" }}>
                <summary style={{ cursor: "pointer", color: "#5b6378", fontSize: "0.875rem" }}>
                  Show full response
                </summary>
                <pre style={{ 
                  background: "#f5f7fb", 
                  padding: "12px", 
                  borderRadius: "8px",
                  fontSize: "0.75rem",
                  overflow: "auto",
                  maxHeight: "200px",
                  marginTop: "8px"
                }}>
                  {paymentResult.jwt}
                </pre>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Activity Log */}
      {messages.length > 0 && (
        <section className="panel wide">
          <div className="panel-head">
            <h3>Activity Log</h3>
          </div>
          <ul className="log" style={{ maxHeight: "200px", overflow: "auto" }}>
            {messages.map((message, index) => (
              <li key={index} style={{ fontSize: "0.875rem", padding: "4px 0" }}>
                {message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
