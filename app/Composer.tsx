"use client";

import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  ChevronRight,
  CircleStop,
  FileText,
  LoaderCircle,
  Paperclip,
  Send,
  X
} from "lucide-react";
import { QueueStatusBar } from "./QueueStatusBar";
import { SessionExecutionControl } from "./ExecutionModeSwitch";
import {
  filterSlashCommands,
  slashCommandDisabledReason,
  type SlashCommand
} from "./slashCommands";
import type { QueueThreadSummary, QueuedPrompt } from "./queueModel";
import { formatBytes } from "./formatUtils";
import type { SessionExecutionState } from "./sessionExecution";
import type { ModeKind, ProviderId } from "./sessionRuntime";
import {
  activeAtQuery,
  chipLabel,
  chipOverLimit,
  parseAtMentions,
  shouldInlineChip,
  type FileContextChip,
  type FileMentionHit
} from "./fileContext";

export type ComposerAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  image: boolean;
  url: string;
};

export type ComposerHandle = {
  focus: () => void;
  appendText: (text: string) => void;
  setDraft: (text: string) => void;
};

type ComposerProps = {
  threadKey: string;
  initialDraft: string;
  providerLabel: string;
  wsState: string;
  submitting: boolean;
  executionTransitioning: boolean;
  executionState: SessionExecutionState;
  sessionCreating: boolean;
  supportsSteer: boolean;
  uploadsInProgress: number;
  currentQueuePaused: boolean;
  attachments: ComposerAttachment[];
  fileContexts: FileContextChip[];
  fileMentions: FileMentionHit[];
  queueSummary: QueueThreadSummary;
  queueAction: string | null;
  slashContext: { hasThread: boolean; activeTurn: boolean; provider?: ProviderId };
  onDraftChange: (text: string) => void;
  onSubmit: (text: string) => Promise<void> | void;
  onSteer: (text: string) => Promise<void> | void;
  onInterrupt: () => Promise<void> | void;
  onRunPlan: () => Promise<void> | void;
  onModeChange: (mode: ModeKind) => Promise<void> | void;
  onSlash: (command: SlashCommand) => Promise<void> | void;
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRemoveFileContext: (id: string) => void;
  onOpenFileContext: (chip: FileContextChip) => void;
  onAtQuery: (query: string | null) => void;
  onPickMention: (hit: FileMentionHit) => void;
  onMentionsParsed: (mentions: Array<{ path: string; startLine: number | null; endLine: number | null }>) => void;
  onRetryQueue: (item: QueuedPrompt) => Promise<void>;
  onRemoveQueue: (item: QueuedPrompt) => Promise<void>;
};

function SlashPalette({
  commands,
  context,
  selectedIndex,
  onHover,
  onSelect
}: {
  commands: SlashCommand[];
  context: { hasThread: boolean; activeTurn: boolean };
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    <div className="slashPalette" role="listbox" aria-label="Slash commands">
      {commands.length ? (
        commands.map((command, index) => {
          const disabledReason = slashCommandDisabledReason(command, context);
          return (
            <button
              aria-disabled={Boolean(disabledReason)}
              className={`slashCommand ${index === selectedIndex ? "selected" : ""} ${disabledReason ? "disabled" : ""}`}
              disabled={Boolean(disabledReason)}
              key={command.id}
              role="option"
              type="button"
              onClick={() => {
                if (disabledReason) return;
                onSelect(command);
              }}
              onMouseEnter={() => onHover(index)}
            >
              <span>
                <strong>{command.label}</strong>
                {command.aliases?.length ? <code>{command.aliases.map((alias) => `/${alias}`).join(", ")}</code> : null}
              </span>
              <small>{disabledReason || command.description}</small>
            </button>
          );
        })
      ) : (
        <div className="slashEmpty">No matching slash commands.</div>
      )}
    </div>
  );
}

function FileMentionPalette({
  hits,
  selectedIndex,
  onHover,
  onSelect
}: {
  hits: FileMentionHit[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (hit: FileMentionHit) => void;
}) {
  return (
    <div className="slashPalette" role="listbox" aria-label="File mentions">
      {hits.length ? (
        hits.map((hit, index) => (
          <button
            className={`slashCommand ${index === selectedIndex ? "selected" : ""}`}
            key={hit.path}
            role="option"
            type="button"
            onClick={() => onSelect(hit)}
            onMouseEnter={() => onHover(index)}
          >
            <span>
              <strong>{hit.name}</strong>
            </span>
            <small>{hit.path !== hit.name ? hit.path : "project root"}</small>
          </button>
        ))
      ) : (
        <div className="slashEmpty">No matching files.</div>
      )}
    </div>
  );
}

export const Composer = memo(forwardRef<ComposerHandle, ComposerProps>(function Composer({
  threadKey,
  initialDraft,
  providerLabel,
  wsState,
  submitting,
  executionTransitioning,
  executionState,
  sessionCreating,
  supportsSteer,
  uploadsInProgress,
  currentQueuePaused,
  attachments,
  fileContexts,
  fileMentions,
  queueSummary,
  queueAction,
  slashContext,
  onDraftChange,
  onSubmit,
  onSteer,
  onInterrupt,
  onRunPlan,
  onModeChange,
  onSlash,
  onPickFiles,
  onRemoveAttachment,
  onRemoveFileContext,
  onOpenFileContext,
  onAtQuery,
  onPickMention,
  onMentionsParsed,
  onRetryQueue,
  onRemoveQueue
}, ref) {
  const activeTurnId = executionState.activeTurnId;
  const hasThread = executionState.hasThread;
  const [draft, setDraft] = useState(initialDraft);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [cursor, setCursor] = useState(initialDraft.length);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(initialDraft);
    setSlashIndex(0);
    setMentionIndex(0);
    setCursor(initialDraft.length);
  }, [initialDraft, threadKey]);

  const updateDraft = (value: string, nextCursor = value.length) => {
    setDraft(value);
    setCursor(nextCursor);
    onDraftChange(value);
  };

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    appendText: (text: string) => {
      setDraft((current) => {
        const separator = current && !/\s$/.test(current) ? " " : "";
        const next = `${current}${separator}${text}`;
        setCursor(next.length);
        onDraftChange(next);
        return next;
      });
      textareaRef.current?.focus();
    },
    setDraft: (text: string) => {
      setDraft(text);
      setCursor(text.length);
      onDraftChange(text);
    }
  }), [onDraftChange]);

  const slashOpen = draft.startsWith("/") && !draft.trim().includes(" ");
  const slashMatches = useMemo(() => (slashOpen ? filterSlashCommands(draft) : []), [draft, slashOpen]);
  const selectedSlashIndex = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const selectedSlashCommand = slashMatches[selectedSlashIndex] || null;
  const atMatch = slashOpen ? null : activeAtQuery(draft, cursor);
  const atOpen = Boolean(atMatch);
  const selectedMentionIndex = fileMentions.length ? Math.min(mentionIndex, fileMentions.length - 1) : 0;
  const selectedMention = fileMentions[selectedMentionIndex] || null;

  useEffect(() => {
    if (!slashOpen) return;
    setSlashIndex(0);
  }, [draft, slashOpen]);

  useEffect(() => {
    setMentionIndex(0);
  }, [atMatch?.query, atOpen]);

  useEffect(() => {
    onAtQuery(atOpen && atMatch ? atMatch.query : null);
  }, [atMatch, atOpen, onAtQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => onMentionsParsed(parseAtMentions(draft)), 160);
    return () => window.clearTimeout(timer);
  }, [draft, onMentionsParsed]);

  const runSlash = (command: SlashCommand) => {
    if (slashCommandDisabledReason(command, slashContext)) return;
    updateDraft("");
    void onSlash(command);
  };

  const pickMention = (hit: FileMentionHit) => {
    if (!atMatch) return;
    const inserted = `@${hit.path} `;
    const queryEnd = atMatch.start + 1 + atMatch.query.length;
    const next = `${draft.slice(0, atMatch.start)}${inserted}${draft.slice(queryEnd)}`;
    updateDraft(next, atMatch.start + inserted.length);
    onPickMention(hit);
    requestAnimationFrame(() => {
      const pos = atMatch.start + inserted.length;
      textareaRef.current?.setSelectionRange(pos, pos);
      textareaRef.current?.focus();
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting || uploadsInProgress > 0) return;
    const text = draft.trim();
    if (!text && attachments.length === 0 && fileContexts.length === 0) return;
    void onSubmit(text);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((current) => (slashMatches.length ? (current + 1) % slashMatches.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((current) =>
          slashMatches.length ? (current - 1 + slashMatches.length) % slashMatches.length : 0
        );
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && selectedSlashCommand && !event.shiftKey) {
        event.preventDefault();
        runSlash(selectedSlashCommand);
        return;
      }
    }
    if (atOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (fileMentions.length ? (current + 1) % fileMentions.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) =>
          fileMentions.length ? (current - 1 + fileMentions.length) % fileMentions.length : 0
        );
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && selectedMention && !event.shiftKey) {
        event.preventDefault();
        pickMention(selectedMention);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (atOpen && atMatch) {
        const queryEnd = atMatch.start + 1 + atMatch.query.length;
        updateDraft(`${draft.slice(0, atMatch.start)}${draft.slice(queryEnd)}`.trimStart(), atMatch.start);
        return;
      }
      if (slashOpen || draft) updateDraft("");
      else if (activeTurnId) void onInterrupt();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey && activeTurnId && supportsSteer) {
        const text = draft.trim();
        if (!text) return;
        updateDraft("");
        void onSteer(text);
        return;
      }
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (!files.length) return;
        event.preventDefault();
        onPickFiles(files);
      }}
    >
      <SessionExecutionControl
        disabled={wsState !== "online" || sessionCreating}
        state={executionState}
        supportsAsk={executionState.provider === "cursor"}
        transitioning={executionTransitioning}
        onChange={onModeChange}
        onExecutePlan={onRunPlan}
      />
      {slashOpen ? (
        <SlashPalette
          commands={slashMatches}
          context={slashContext}
          selectedIndex={selectedSlashIndex}
          onHover={setSlashIndex}
          onSelect={runSlash}
        />
      ) : atOpen ? (
        <FileMentionPalette
          hits={fileMentions}
          selectedIndex={selectedMentionIndex}
          onHover={setMentionIndex}
          onSelect={pickMention}
        />
      ) : null}
      <input
        className="hiddenFileInput"
        multiple
        ref={fileInputRef}
        type="file"
        onChange={(event) => {
          onPickFiles([...(event.currentTarget.files || [])]);
          event.currentTarget.value = "";
        }}
      />
      {attachments.length ? (
        <div className="attachmentTray">
          {attachments.map((attachment) => (
            <div className="attachmentChip" key={attachment.id}>
              {attachment.image ? (
                <img alt="" height={42} src={attachment.url} width={42} />
              ) : (
                <span className="attachmentFileIcon" aria-hidden="true"><FileText size={20} /></span>
              )}
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatBytes(attachment.size)} · On server</small>
              </span>
              <button aria-label={`Remove ${attachment.name}`} type="button" onClick={() => onRemoveAttachment(attachment.id)} title="Remove file">
                <X aria-hidden="true" size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {fileContexts.length ? (
        <div className="fileContextTray">
          {fileContexts.map((chip) => {
            const mentionOnly = !shouldInlineChip(chip, fileContexts) || chipOverLimit(chip);
            return (
              <div className={`fileContextChip${mentionOnly ? " overLimit" : ""}`} key={chip.id}>
                <button
                  className="fileContextLabel"
                  title={mentionOnly ? `${chipLabel(chip)} · mention only` : chipLabel(chip)}
                  type="button"
                  onClick={() => onOpenFileContext(chip)}
                >
                  <strong>{chipLabel(chip)}</strong>
                  {mentionOnly ? <small>mention only</small> : null}
                </button>
                <button aria-label={`Remove ${chipLabel(chip)}`} title="Remove file context" type="button" onClick={() => onRemoveFileContext(chip.id)}>
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {hasThread ? (
        <QueueStatusBar
          key={threadKey}
          summary={queueSummary}
          busyAction={queueAction}
          onRetry={onRetryQueue}
          onRemove={onRemoveQueue}
        />
      ) : null}
      <div className="composerInputRow">
        <textarea
          aria-label="Task prompt"
          ref={textareaRef}
          value={draft}
          wrap="soft"
          onChange={(event) => updateDraft(event.target.value, event.target.selectionStart)}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (!files.length) return;
            onPickFiles(files);
          }}
          onKeyDown={handleKeyDown}
          placeholder={currentQueuePaused ? "Send to retry the saved queue…" : activeTurnId ? "Send to queue the next task…" : `Send a task to ${providerLabel}…`}
          rows={2}
        />
      <div className="composerActions">
        <div className="composerSecondaryActions">
          <button
            aria-label="Attach files to agent"
            title="Attach files to agent"
            type="button"
            disabled={uploadsInProgress > 0}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadsInProgress > 0 ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={17} /> : <Paperclip aria-hidden="true" size={17} />}
            {uploadsInProgress > 0 ? `Uploading ${uploadsInProgress}` : "Agent files"}
          </button>
          {activeTurnId && supportsSteer ? (
            <button
              type="button"
              title="Steer the active run now"
              onClick={() => {
                const text = draft.trim();
                if (!text) return;
                updateDraft("");
                void onSteer(text);
              }}
              disabled={!draft.trim()}
            >
              <ChevronRight size={17} />
              Steer
            </button>
          ) : null}
        </div>
        <div className="composerPrimaryActions">
          {activeTurnId || executionState.phase === "running" ? (
            <button aria-label="Stop" className="dangerButton" type="button" onClick={() => void Promise.resolve(onInterrupt())}>
              <CircleStop size={17} />
              Stop
            </button>
          ) : null}
          <button
            aria-label={submitting ? "Saving" : "Send"}
            className="primaryButton composerBarSend"
            type="submit"
            disabled={wsState !== "online" || submitting || uploadsInProgress > 0}
          >
            {submitting ? <LoaderCircle aria-hidden="true" className="queueSpinner" size={17} /> : <Send size={17} />}
            {submitting ? "Saving…" : "Send"}
          </button>
        </div>
      </div>
      </div>
    </form>
  );
}));
