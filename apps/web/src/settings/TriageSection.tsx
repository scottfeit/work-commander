import { useCallback, useEffect, useState } from "react";
import type {
  EnvironmentInfo,
  LayaPartStatus,
  LayaStatus,
  Settings,
} from "@wc/shared";
import { LAYA_PARTS } from "@wc/shared";
import { get, post, useServerEvents } from "../api";
import { Row, Select } from "./parts";

const STATE_LABEL: Record<LayaPartStatus["state"], string> = {
  collecting: "Collecting examples",
  shadowing: "Shadowing Claude",
  proposed: "Ready to switch",
  live: "Laya decides",
};

/** Settings → Triage: Claude or Laya, Laya's install, and each part's progress from shadowing to taking over. */
export function TriageSection({
  s,
  saved,
  up,
  env,
}: {
  s: Settings;
  saved: Settings;
  up: <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void;
  env: EnvironmentInfo;
}) {
  const [st, setSt] = useState<LayaStatus | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(
    () =>
      get<LayaStatus>("/api/laya/status").then(setSt, (e) => setErr(e.message)),
    [],
  );
  useEffect(() => void load(), [load]);
  useServerEvents((e) => {
    if (e.type === "laya.status") setSt(e.status);
  });
  const act = async (path: string) => {
    setErr("");
    try {
      await post(path);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const local = env.hosting === "local";
  const chosen = saved.triage.engine === "laya";
  const triageModel = s.claude.taskModels?.triage ?? "main";
  const fallback =
    triageModel === "main"
      ? `the main model (${s.claude.model})`
      : triageModel[0].toUpperCase() + triageModel.slice(1);

  return (
    <section>
      <h2>Triage</h2>
      <Row
        label="Triage with"
        hint="Laya is a small model that runs on this computer. It learns from Claude's triage decisions and your corrections, then takes over each part of triage once it agrees with Claude often enough and you say yes."
      >
        <Select
          value={s.triage.engine}
          onChange={(engine) => up("triage", { engine })}
          options={[
            { value: "claude", label: "Claude" },
            {
              value: "laya",
              label: "Laya, learning from Claude",
              disabled: !local,
            },
          ]}
        />
        {!local && (
          <div className="small muted">
            Laya runs only when Work Commander is hosted on your own computer.
          </div>
        )}
        {s.triage.engine === "laya" && (
          <div className="small muted">
            Until Laya takes over a part, and whenever it isn't sure, triage
            uses {fallback} (Settings → Claude).
          </div>
        )}
      </Row>
      {s.triage.engine === "laya" && (
        <>
          <Row
            label="Agreement needed"
            hint="Laya must agree with Claude at least this often, over at least this many messages, before WC asks you to switch a part over. Each part is judged on its own."
          >
            <div className="row-form">
              <input
                className="num"
                type="number"
                min={50}
                max={100}
                aria-label="Agreement needed (%)"
                value={Math.round(s.triage.agreeThreshold * 100)}
                onChange={(e) =>
                  up("triage", {
                    agreeThreshold: Math.min(
                      1,
                      Math.max(0.5, Number(e.target.value) / 100),
                    ),
                  })
                }
              />
              <span className="small muted">% over</span>
              <input
                className="num"
                type="number"
                min={20}
                max={5000}
                aria-label="Messages needed"
                value={s.triage.minMessages}
                onChange={(e) =>
                  up("triage", {
                    minMessages: Math.max(
                      20,
                      Math.round(Number(e.target.value)),
                    ),
                  })
                }
              />
              <span className="small muted">messages</span>
            </div>
          </Row>
          {!chosen && (
            <p className="small muted">
              Save to start collecting examples for Laya.
            </p>
          )}
        </>
      )}

      {local &&
        (s.triage.engine === "laya" || st?.install.state === "installed") &&
        st && (
          <>
            <h3>Laya</h3>
            {err && <div className="error">{err}</div>}
            <Row
              label="Install"
              hint="Downloads the uv tool, a private Python 3.12, Laya and its model (about 2 GB in all) into Work Commander's data folder. Your own Python is not touched."
            >
              {st.install.state === "installed" ? (
                <span className="ok">
                  Installed
                  {st.install.message ? ` (${st.install.message})` : ""}
                </span>
              ) : st.install.state === "installing" ? (
                <span className="chip running">
                  {st.install.progress ?? "Installing…"}
                </span>
              ) : (
                <>
                  <div className="row-form">
                    <button
                      className="btn small primary"
                      disabled={!chosen}
                      title={chosen ? undefined : "Save first"}
                      onClick={() => act("/api/laya/install")}
                    >
                      {st.install.state === "failed"
                        ? "Try the install again"
                        : "Install Laya"}
                    </button>
                  </div>
                  {st.install.state === "failed" && (
                    <div className="small error">{st.install.message}</div>
                  )}
                </>
              )}
            </Row>
            {st.install.state === "installed" && (
              <Row label="Status">
                <span className={st.server.running ? "ok" : "muted"}>
                  {st.server.running
                    ? "Running"
                    : chosen
                      ? "Starting…"
                      : "Stopped (Claude is triaging)"}
                </span>
                {st.server.message && (
                  <div className="small error">{st.server.message}</div>
                )}
                {st.training.message && (
                  <div
                    className={`small ${st.training.message.startsWith("Training failed") ? "error" : "muted"}`}
                  >
                    {st.training.message}
                  </div>
                )}
              </Row>
            )}
            <table className="laya-parts">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Stage</th>
                  <th>Progress</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {st.parts.map((p) => (
                  <PartRow
                    key={p.part}
                    p={p}
                    s={saved}
                    installed={st.install.state === "installed"}
                    training={st.training.running}
                    act={act}
                  />
                ))}
              </tbody>
            </table>
            <p className="small muted">
              Laya is first trained automatically once a part has enough
              examples. After that it is only retrained when you press Retrain,
              which starts that part's shadowing again from the beginning.
            </p>
            {st.disagreements.length > 0 && (
              <>
                <h3>Recent disagreements</h3>
                <table className="laya-dis">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Part</th>
                      <th>Message</th>
                      <th>Laya said</th>
                      <th>Claude said</th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.disagreements.map((d, i) => (
                      <tr key={i}>
                        <td>{new Date(d.at).toLocaleString()}</td>
                        <td>
                          {LAYA_PARTS.find((x) => x.id === d.part)?.label}
                        </td>
                        <td>{d.title}</td>
                        <td>{d.laya}</td>
                        <td>{d.claude}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
    </section>
  );
}

function PartRow({
  p,
  s,
  installed,
  training,
  act,
}: {
  p: LayaPartStatus;
  s: Settings;
  installed: boolean;
  training: boolean;
  act: (path: string) => void;
}) {
  const label = LAYA_PARTS.find((x) => x.id === p.part)!.label;
  const pct = p.compared ? Math.round((100 * p.agreed) / p.compared) : null;
  const need = s.triage.minMessages;
  const progress =
    p.state === "collecting"
      ? `${p.examples} of ${p.examplesNeeded} examples${installed ? "" : " (install Laya to train)"}`
      : p.state === "live"
        ? `${p.compared} decisions by Laya${pct !== null && p.compared ? `, ${pct}% not corrected by you` : ""}`
        : `${pct ?? 0}% agreement over ${p.compared} of ${need} messages (target ${Math.round(s.triage.agreeThreshold * 100)}%)`;
  return (
    <tr>
      <td>{label}</td>
      <td>
        <span
          className={`chip ${p.state === "proposed" ? "attention" : p.state === "live" ? "running" : ""}`}
        >
          {STATE_LABEL[p.state]}
        </span>
        {p.version > 0 && <span className="small muted"> v{p.version}</span>}
      </td>
      <td className="small">
        {progress}
        {p.suggestRetrain && (
          <div className="error">Your corrections suggest retraining.</div>
        )}
      </td>
      <td>
        <div className="laya-actions">
          {p.state === "proposed" && (
            <>
              <button
                className="btn small primary"
                onClick={() => act(`/api/laya/parts/${p.part}/accept`)}
              >
                Switch to Laya
              </button>
              <button
                className="btn small ghost"
                onClick={() => act(`/api/laya/parts/${p.part}/decline`)}
              >
                Not yet
              </button>
            </>
          )}
          {p.state === "live" && (
            <button
              className="btn small ghost"
              onClick={() => act(`/api/laya/parts/${p.part}/stop`)}
            >
              Back to Claude
            </button>
          )}
          {installed && p.examples > 0 && (
            <button
              className="btn small ghost"
              disabled={training}
              onClick={() => act(`/api/laya/parts/${p.part}/train`)}
              title="Train on every example so far. The new version shadows Claude from the beginning."
            >
              {p.version > 0 ? "Retrain" : "Train now"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
