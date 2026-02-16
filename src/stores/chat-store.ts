import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuid } from 'uuid';
import type { ChatMessage, AgentAction, SkillProgress } from '@/types/chat';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  activeSkill: string | null;
  skillProgress: SkillProgress | null;
}

interface ChatActions {
  addMessage: (role: ChatMessage['role'], content: string, action?: AgentAction) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  setIsLoading: (loading: boolean) => void;
  setActiveSkill: (skill: string | null) => void;
  setSkillProgress: (progress: SkillProgress | null) => void;
  clearHistory: () => void;
}

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
    clearHistory: () =>
      set({
        messages: [
          {
            id: 'welcome',
            role: 'assistant',
            content: 'Chat cleared. How can I help?',
            timestamp: Date.now(),
          },
        ],
      }),
  }))
);
