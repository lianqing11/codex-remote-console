"use client";

import { memo, useDeferredValue, useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ProviderId } from "./sessionRuntime";
import { nowSeconds, isUserMessageItem, reuseDisplayTurns, shouldShowPendingPrompt, type DisplayTurn, type ThreadItem, type TurnGroup, type WorkLogSummary } from "./threadModel";
import { useThreadTranscript } from "./threadViewStore";
import { TurnPanel, type GatewayDiagnostic, type ProjectDiff } from "./conversationViews";

function inputItems(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function groupRounds(
  items: Record<string, ThreadItem>,
  itemOrder: string[],
  turnsById: Record<string, TurnGroup>,
  turnOrder: string[],
  pendingPrompt: string,
  activeTurnId: string | null
): DisplayTurn[] {
  const rounds: DisplayTurn[] = [];
  const chronologicalItems = itemOrder.map((id) => items[id]).filter((item): item is ThreadItem => Boolean(item));
  const turnIdByItemId = new Map<string, string>();
  const roundsByTurnId = new Map<string, DisplayTurn>();
  const seenItemIds = new Set<string>();

  for (const turnId of turnOrder) {
    const turn = turnsById[turnId];
    if (!turn) continue;
    for (const itemId of turn.itemIds || []) {
      if (!turnIdByItemId.has(itemId)) turnIdByItemId.set(itemId, turnId);
    }
  }

  let currentLooseRound: DisplayTurn | null = null;
  for (const item of chronologicalItems) {
    if (seenItemIds.has(item.id)) continue;
    seenItemIds.add(item.id);
    const turnId = turnIdByItemId.get(item.id);
    const turn = turnId ? turnsById[turnId] : null;
    if (turnId && turn) {
      let round = roundsByTurnId.get(turnId);
      if (!round) {
        round = { ...turn, itemIds: [], items: [] };
        roundsByTurnId.set(turnId, round);
        rounds.push(round);
      }
      round.itemIds.push(item.id);
      round.items.push(item);
      currentLooseRound = null;
      continue;
    }
    if (isUserMessageItem(item) || !currentLooseRound) {
      currentLooseRound = {
        id: `round-${item.id}`,
        itemIds: [item.id],
        status: { type: "completed" },
        items: [item]
      };
      rounds.push(currentLooseRound);
      continue;
    }
    currentLooseRound.itemIds.push(item.id);
    currentLooseRound.items.push(item);
  }

  const displayRounds = rounds.reverse();
  if (shouldShowPendingPrompt(pendingPrompt, displayRounds[0] || null, activeTurnId)) {
    displayRounds.unshift({
      id: "pending-start",
      itemIds: ["pending-user-message"],
      status: { type: activeTurnId ? "inProgress" : "sending" },
      startedAt: nowSeconds(),
      updatedAt: nowSeconds(),
      pending: true,
      items: [{ id: "pending-user-message", type: "userMessage", content: inputItems(pendingPrompt) }]
    });
  }
  return displayRounds;
}

type StartProviderOption = {
  id: ProviderId;
  label: string;
  available: boolean;
};

type ConversationPaneProps = {
  threadKey: string;
  provider: ProviderId;
  providerLabel: string;
  hasThread: boolean;
  activeTurnId: string | null;
  historyLoading: boolean;
  historyLimit: number;
  onShowAllHistory: () => void;
  diagnostic: GatewayDiagnostic | null;
  onOpenDiff?: (diff: ProjectDiff) => void;
  onForkTurn?: (turnId: string) => void;
  onAnswerQuestion?: (text: string) => void;
  onLoadWorkLog?: (threadKey: string, turnId: string, workLog: WorkLogSummary) => Promise<void>;
  forkDisabledReason?: string;
  wsOnline: boolean;
  startProviders?: StartProviderOption[];
  selectedProvider?: ProviderId;
  sessionCreating?: boolean;
  onStartProvider?: (provider: ProviderId) => void;
  onProviderDetails?: () => void;
  directory?: string;
  onChooseDirectory?: () => void;
};

export const ConversationPane = memo(function ConversationPane({
  threadKey,
  provider,
  providerLabel,
  hasThread,
  activeTurnId,
  historyLoading,
  historyLimit,
  onShowAllHistory,
  diagnostic,
  onOpenDiff, onForkTurn, forkDisabledReason, onLoadWorkLog, onAnswerQuestion,
  wsOnline,
  startProviders = [],
  selectedProvider,
  sessionCreating = false,
  onStartProvider,
  onProviderDetails,
  directory,
  onChooseDirectory
}: ConversationPaneProps) {
  const transcript = useThreadTranscript(threadKey);
  const loadWorkLog = useMemo(() => onLoadWorkLog
    ? (turnId: string, workLog: WorkLogSummary) => onLoadWorkLog(threadKey, turnId, workLog)
    : undefined, [onLoadWorkLog, threadKey]);
  const renderedItems = useDeferredValue(transcript.items);
  const previousRoundsRef = useRef<DisplayTurn[]>([]);
  const previousThreadKeyRef = useRef(threadKey);
  // Membership changes on new items/turns, not on each streamed text delta.
  const roundIndex = useMemo(() => groupRounds(
    transcript.items, transcript.itemOrder, transcript.turnsById, transcript.turnOrder, "", null
  ), [threadKey, transcript.itemOrder, transcript.turnsById, transcript.turnOrder]);
  const groupedRounds = useMemo(() => {
    if (previousThreadKeyRef.current !== threadKey) {
      previousRoundsRef.current = [];
      previousThreadKeyRef.current = threadKey;
    }
    const next = roundIndex.slice(0, historyLimit).map((round) => ({
      ...round, items: round.itemIds.map((id) => renderedItems[id]).filter(Boolean)
    }));
    if (shouldShowPendingPrompt(transcript.pendingPrompt, next[0] || null, activeTurnId)) {
      next.unshift({
        id: "pending-start", itemIds: ["pending-user-message"], pending: true,
        status: { type: activeTurnId ? "inProgress" : "sending" },
        items: [{ id: "pending-user-message", type: "userMessage", content: inputItems(transcript.pendingPrompt) }]
      });
    }
    const reused = reuseDisplayTurns(previousRoundsRef.current, next);
    previousRoundsRef.current = reused;
    return reused;
  }, [activeTurnId, historyLimit, renderedItems, roundIndex, threadKey, transcript.pendingPrompt]);
  const visibleRounds = groupedRounds;
  const hiddenRoundCount = Math.max(0, roundIndex.length - historyLimit);
  const activeTurnItemIds = activeTurnId ? new Set(transcript.turnsById[activeTurnId]?.itemIds || []) : null;

  return (
    <div className="turnList">
      {historyLoading ? (
        <div className="historyLoadingBanner" role="status">
          <span className="pulseDot" />
          Opening session… {groupedRounds.length ? "Refreshing history in the background." : "Loading conversation history."}
        </div>
      ) : null}
      {groupedRounds.length === 0 ? (
        <div className="emptyState">
          <Sparkles size={26} />
          <h2>
            {historyLoading ? "Opening session" : hasThread ? "New session ready" : `Start a ${providerLabel} session`}
          </h2>
          <p>
            {historyLoading
              ? "You can keep browsing; history will appear when ready."
              : hasThread
                ? "Send the first task below."
                : wsOnline
                  ? "Send a task below to start. Directory and agent options are in the workspace controls."
                  : `${providerLabel} is reconnecting. You can browse directories while it connects.`}
          </p>
          {!historyLoading && !hasThread && onStartProvider && startProviders.length ? (
            <>
              <button className="emptyDirectoryButton" type="button" onClick={onChooseDirectory}>
                <span>Working directory</span>
                <strong title={directory || undefined}>{directory?.split("/").filter(Boolean).pop() || "Choose a directory…"}</strong>
                {directory ? <small dir="ltr" translate="no">{directory}</small> : null}
              </button>
              <div className="emptyStateActions providerToggle" role="radiogroup" aria-label="Agent for new sessions">
                {startProviders.map((option) => {
                  const selected = option.id === (selectedProvider || provider);
                  return (
                    <button
                      aria-checked={selected}
                      aria-label={option.label}
                      className={`providerChip ${selected ? "active newSessionPrimary" : ""} ${option.available ? "" : "unavailable"}`}
                      disabled={sessionCreating || !option.available}
                      key={option.id}
                      role="radio"
                      type="button"
                      onClick={() => onStartProvider(option.id)}
                    >
                      <span>New {option.label}</span>
                      <small>{option.available ? "ready" : "unavailable"}</small>
                    </button>
                  );
                })}
              </div>
              {onProviderDetails ? (
                <button className="emptyStateDetails" title="Provider details" type="button" onClick={onProviderDetails}>
                  Provider details
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <>
          {visibleRounds.map((turn, index) => {
            const active = Boolean(turn.pending || (activeTurnItemIds && turn.itemIds.some((id) => activeTurnItemIds.has(id))));
            return (
              <TurnPanel
                active={active}
                defaultOpen={index === 0}
                diagnostic={active ? diagnostic : null}
                key={turn.id}
                onOpenDiff={onOpenDiff}
                onForkTurn={onForkTurn}
                onLoadWorkLog={loadWorkLog}
                onAnswerQuestion={index === 0 && !activeTurnId && !turn.pending ? onAnswerQuestion : undefined}
                forkDisabledReason={forkDisabledReason}
                provider={provider}
                turn={turn}
              />
            );
          })}
          {hiddenRoundCount > 0 ? (
            <button className="historyMoreButton" type="button" onClick={onShowAllHistory}>
              Show {Math.min(40, hiddenRoundCount)} earlier messages · {hiddenRoundCount} remaining
            </button>
          ) : null}
        </>
      )}
    </div>
  );
});
