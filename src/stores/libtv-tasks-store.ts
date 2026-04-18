import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type TaskStatus = 'pending' | 'polling' | 'done' | 'failed'

export interface LibtvTask {
  id: string;
  nodeId: string;
  itemId: string;
  prompt: string;
  sessionId?: string;
  status: TaskStatus;
  resultUrl?: string;
  resultKind?: 'image' | 'video';
  error?: string;
  createdAt: number;
}

interface State {
  tasks: Record<string, LibtvTask>;
}
interface Actions {
  startTask: (task: Omit<LibtvTask, 'status' | 'createdAt'>) => void;
  updateTask: (id: string, patch: Partial<LibtvTask>) => void;
  removeTask: (id: string) => void;
}

export const useLibtvTasksStore = create<State & Actions>()(
  immer((set) => ({
    tasks: {},
    startTask: (task) => set((s) => {
      s.tasks[task.id] = { ...task, status: 'pending', createdAt: Date.now() }
    }),
    updateTask: (id, patch) => set((s) => {
      const t = s.tasks[id]; if (t) Object.assign(t, patch)
    }),
    removeTask: (id) => set((s) => { delete s.tasks[id] }),
  }))
)
