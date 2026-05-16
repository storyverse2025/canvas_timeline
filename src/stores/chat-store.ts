import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuid } from 'uuid';
import type { ChatMessage, AgentAction, SkillProgress } from '@/types/chat';
import type { Answer, Question } from '@/lib/agents/_shared/runtime/types';

/**
 * An interview question that an agent has yielded and is waiting on. ChatPanel
 * renders this slot as an <InterviewCard/>; the user's Submit click resolves
 * the promise the agent is awaiting.
 */
export interface PendingQuestion {
  id: string;
  /** Label rendered above the question — usually "<agent>/<verb>". */
  agentLabel: string;
  question: Question;
}

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  activeSkill: string | null;
  skillProgress: SkillProgress | null;
  pendingQuestion: PendingQuestion | null;
}

interface ChatActions {
  addMessage: (role: ChatMessage['role'], content: string, action?: AgentAction) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  setIsLoading: (loading: boolean) => void;
  setActiveSkill: (skill: string | null) => void;
  setSkillProgress: (progress: SkillProgress | null) => void;
  clearHistory: () => void;
  /** Called by agent bridge — returns a Promise that resolves when answerQuestion is called. */
  presentQuestion: (agentLabel: string, question: Question) => Promise<Answer>;
  /** Called by InterviewCard.onSubmit. */
  answerQuestion: (id: string, answer: Answer) => void;
}

/**
 * Pending-question resolvers live outside zustand state so the store stays
 * serializable. Keyed by question id; set when presentQuestion is called,
 * popped + invoked when answerQuestion fires.
 */
const pendingResolvers = new Map<string, (answer: Answer) => void>();

export const useChatStore = create<ChatState & ChatActions>()(
  immer((set) => ({
    messages: [
      {
        id: 'welcome',
        role: 'assistant',
        content: 'Welcome! I can help you create videos. Try:\n- "Generate script" to create a story\n- "Generate characters" to create characters\n- "Auto-map timeline" to connect everything\n- "Run full pipeline" to do it all at once',
        timestamp: Date.now(),
      },
    ],
    isLoading: false,
    activeSkill: null,
    skillProgress: null,
    pendingQuestion: null,

    addMessage: (role, content, action) => {
      const id = uuid();
      set((state) => {
        state.messages.push({ id, role, content, timestamp: Date.now(), action });
      });
      return id;
    },

    updateMessage: (id, updates) => {
      set((state) => {
        const msg = state.messages.find((m) => m.id === id);
        if (msg) Object.assign(msg, updates);
      });
    },

    setIsLoading: (loading) => set({ isLoading: loading }),
    setActiveSkill: (skill) => set({ activeSkill: skill }),
    setSkillProgress: (progress) => set({ skillProgress: progress }),
    clearHistory: () => {
      // Reject any in-flight question so the agent doesn't hang forever.
      for (const resolve of pendingResolvers.values()) {
        resolve({ selected: [] });
      }
      pendingResolvers.clear();
      set({
        pendingQuestion: null,
        messages: [
          {
            id: 'welcome',
            role: 'assistant',
            content: 'Chat cleared. How can I help?',
            timestamp: Date.now(),
          },
        ],
      });
    },

    presentQuestion: (agentLabel, question) => {
      const id = uuid();
      set((state) => {
        state.pendingQuestion = { id, agentLabel, question };
      });
      return new Promise<Answer>((resolve) => {
        pendingResolvers.set(id, resolve);
      });
    },

    answerQuestion: (id, answer) => {
      const resolve = pendingResolvers.get(id);
      pendingResolvers.delete(id);
      set((state) => {
        // Only clear if this id is still the active one (defensive against
        // multiple Submit clicks or stale answers).
        if (state.pendingQuestion?.id === id) state.pendingQuestion = null;
      });
      resolve?.(answer);
    },
  }))
);
