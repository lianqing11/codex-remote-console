"use client";

import { memo, useDeferredValue, useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ProviderId } from "./sessionRuntime";
import { nowSeconds, isUserMessageItem, reuseDisplayTurns, shouldShowPendingPrompt, type DisplayTurn, type ThreadItem, type TurnGroup } from "./threadModel";
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
  showAllHistory: boolean;
  onShowAllHistory: () => void;
  diagnostic: GatewayDiagnostic | null;
  onOpenDiff?: (diff: ProjectDiff) => void;
  wsOnline: boolean;
  startProviders?: StartProviderOption[];
  selectedProvider?: ProviderId;
  sessionCreating?: boolean;
  onStartProvider?: (provider: ProviderId) => void;
  onProviderDetails?: () => void;
};

export const ConversationPane = memo(function ConversationPane({
  threadKey,
  provider,
  providerLabel,
  hasThread,
  activeTurnId,
  historyLoading,
  showAllHistory,
  onShowAllHistory,
  diagnostic,
  onOpenDiff,
  wsOnline,
  startProviders = [],
  selectedProvider,
  sessionCreating = false,
  onStartProvider,
  onProviderDetails
}: ConversationPaneProps) {
  const transcript = useThreadTranscript(threadKey);
  const renderedItems = useDeferredValue(transcript.items);
  const previousRoundsRef = useRef<DisplayTurn[]>([]);
  const previousThreadKeyRef = useRef(threadKey);
  const groupedRounds = useMemo(() => {
    if (previousThreadKeyRef.current !== threadKey) {
      previousRoundsRef.current = [];
      previousThreadKeyRef.current = threadKey;
    }
    const next = groupRounds(
      renderedItems,
      transcript.itemOrder,
      transcript.turnsById,
      transcript.turnOrder,
      transcript.pendingPrompt,
      activeTurnId
    );
    const reused = reuseDisplayTurns(previousRoundsRef.current, next);
    previousRoundsRef.current = reused;
    return reused;
  }, [activeTurnId, renderedItems, threadKey, transcript.itemOrder, transcript.pendingPrompt, transcript.turnOrder, transcript.turnsById]);
  const visibleRounds = showAllHistory || groupedRounds.length <= 40 ? groupedRounds : groupedRounds.slice(0, 40);
  const hiddenRoundCount = groupedRounds.length - visibleRounds.length;
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
                  ? "Choose a provider, then send a task to create the session."
                  : `${providerLabel} is reconnecting. You can browse directories while it connects.`}
          </p>
          {!historyLoading && !hasThread && onStartProvider && startProviders.length ? (
            <>
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
                provider={provider}
                turn={turn}
              />
            );
          })}
          {hiddenRoundCount > 0 ? (
            <button className="historyMoreButton" type="button" onClick={onShowAllHistory}>
              Show {hiddenRoundCount} earlier message{hiddenRoundCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
});
