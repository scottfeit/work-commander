import { useEffect, useState } from "react";
import type { Settings, UsageKind, UsageReport, UsageTotals } from "@wc/shared";
import { USAGE_KIND_LABELS, formatUsage, totalTokens } from "@wc/shared";
import { get } from "../api";
import { Row, Select, Toggle } from "./parts";

const KIND_ORDER: UsageKind[] = [
  "triage",
  "newStream",
  "topicSplit",
  "slackContext",
  "mcpIngest",
  "agent",
  "test",
  "laya",
];

/** Settings → Usage: how usage is shown, the daily budget and its alerts, and the last 30 days. */
export function UsageSection({
  s,
  up,
}: {
  s: Settings;
  up: <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void;
}) {
  const [r, setR] = useState<UsageReport | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState("");
  useEffect(() => {
    get<UsageReport>(`/api/usage?days=${days}`).then(setR, (e) =>
      setErr(e.message),
    );
  }, [days]);
  const unit = s.usage.unit;
  const val = (t: UsageTotals) =>
    unit === "dollars" ? t.costUsd : totalTokens(t);
  const max = Math.max(1e-9, ...(r?.days ?? []).map((d) => val(d.total)));
  const budget = s.usage.dailyBudget;

  return (
    <section>
      <h2>Usage</h2>
      <p className="muted small">
        Every Claude call Work Commander makes is recorded here. Dollar figures
        are estimates at Anthropic's API prices. With a Claude Code login you
        pay by subscription, not per token.
      </p>
      <Row label="Show usage as">
        <Select
          value={unit}
          onChange={(v) => up("usage", { unit: v })}
          options={[
            { value: "tokens", label: "Tokens" },
            { value: "dollars", label: "Dollars (estimated)" },
          ]}
        />
      </Row>
      <Row
        label="Daily budget"
        hint={`An alert when today's usage passes this. 0 = no budget. Nothing is paused.`}
      >
        <div className="row-form">
          <input
            className="num wide"
            type="number"
            min={0}
            step={unit === "dollars" ? 0.5 : 10000}
            aria-label="Daily budget"
            value={budget}
            onChange={(e) =>
              up("usage", {
                dailyBudget: Math.max(0, Number(e.target.value) || 0),
              })
            }
          />{" "}
          <span className="small muted">
            {unit === "dollars" ? "dollars a day" : "tokens a day"}
          </span>
        </div>
      </Row>
      <Row
        label="Budget alert"
        hint="Where the alert goes, once a day, when the budget is passed."
      >
        <div className="col">
          <Toggle
            checked={s.usage.alertBanner}
            onChange={(alertBanner) => up("usage", { alertBanner })}
            label="Banner in Work Commander"
          />
          <Toggle
            checked={s.usage.alertDesktop}
            onChange={(alertDesktop) => {
              up("usage", { alertDesktop });
              if (
                alertDesktop &&
                "Notification" in window &&
                Notification.permission === "default"
              )
                void Notification.requestPermission();
            }}
            label="Desktop notification"
          />
          {s.usage.alertDesktop &&
            "Notification" in window &&
            Notification.permission === "denied" && (
              <span className="small error">
                Your browser blocks notifications from Work Commander. Allow
                them in the browser's site settings.
              </span>
            )}
          <Toggle
            checked={s.usage.alertEmail}
            onChange={(alertEmail) => up("usage", { alertEmail })}
            label={`Email to myself${s.pu.email ? ` (${s.pu.email})` : ""}`}
          />
          {s.usage.alertEmail && s.google.mode !== "oauth" && (
            <span className="small error">
              Email alerts need Google Workspace connected with OAuth.
            </span>
          )}
        </div>
      </Row>

      {err && <div className="error">{err}</div>}
      {r && (
        <>
          <h3>
            Today: {formatUsage(r.today, unit)}
            {budget > 0 && (
              <span className="muted small">
                {" "}
                of{" "}
                {unit === "dollars"
                  ? `$${budget}`
                  : `${budget.toLocaleString()} tokens`}
              </span>
            )}
          </h3>
          <div className="usage-head">
            <h3>By day</h3>
            <Select
              value={String(days) as "7" | "30" | "90" | "365"}
              onChange={(v) => setDays(Number(v))}
              options={[
                { value: "7", label: "Last 7 days" },
                { value: "30", label: "Last 30 days" },
                { value: "90", label: "Last 90 days" },
                { value: "365", label: "Last year" },
              ]}
            />
          </div>
          {r.days.length === 0 ? (
            <p className="muted small">No usage recorded yet.</p>
          ) : (
            <div className="usage-days" role="table" aria-label="Usage by day">
              {[...r.days].reverse().map((d) => (
                <div className="usage-day" role="row" key={d.day}>
                  <span role="cell" className="usage-date">
                    {d.day}
                  </span>
                  <span
                    role="cell"
                    className="usage-bar"
                    title={KIND_ORDER.filter((k) => d.byKind[k])
                      .map(
                        (k) =>
                          `${USAGE_KIND_LABELS[k]}: ${formatUsage(d.byKind[k]!, unit)}`,
                      )
                      .join("\n")}
                  >
                    {KIND_ORDER.filter((k) => d.byKind[k]).map((k) => (
                      <i
                        key={k}
                        className={`k-${k}`}
                        style={{ width: `${(100 * val(d.byKind[k]!)) / max}%` }}
                      />
                    ))}
                  </span>
                  <span role="cell" className="usage-num">
                    {formatUsage(d.total, unit)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="usage-legend small muted">
            {KIND_ORDER.filter((k) => r.byKind.some((x) => x.kind === k)).map(
              (k) => (
                <span key={k}>
                  <i className={`k-${k}`} /> {USAGE_KIND_LABELS[k]}
                </span>
              ),
            )}
          </div>
          <h3>By kind of call</h3>
          <UsageTable
            rows={r.byKind.map((x) => ({
              name: USAGE_KIND_LABELS[x.kind] ?? x.kind,
              t: x.totals,
            }))}
            unit={unit}
          />
          <h3>By model</h3>
          <UsageTable
            rows={r.byModel.map((x) => ({ name: x.model, t: x.totals }))}
            unit={unit}
          />
        </>
      )}
    </section>
  );
}

function UsageTable({
  rows,
  unit,
}: {
  rows: { name: string; t: UsageTotals }[];
  unit: "tokens" | "dollars";
}) {
  if (!rows.length) return <p className="muted small">Nothing yet.</p>;
  const k = (n: number) =>
    n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th></th>
          <th>Calls</th>
          <th>Input</th>
          <th>Cached</th>
          <th>Output</th>
          <th>{unit === "dollars" ? "Est. cost" : "Total"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>{r.t.calls}</td>
            <td>{k(r.t.inputTokens + r.t.cacheWriteTokens)}</td>
            <td>{k(r.t.cacheReadTokens)}</td>
            <td>{k(r.t.outputTokens)}</td>
            <td>{formatUsage(r.t, unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
