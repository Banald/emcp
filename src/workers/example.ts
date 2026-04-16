import type { WorkerDefinition } from '../shared/workers/types.ts';

const worker: WorkerDefinition = {
  name: 'heartbeat',
  description: 'Emits a heartbeat log every five minutes — reference worker for authoring.',
  schedule: '*/5 * * * *',
  handler: async (ctx) => {
    ctx.logger.info('heartbeat');
  },
};

export default worker;
