// Custom resource Lambda que dispara `prisma migrate deploy` como tareas Fargate
// one-off, una por servicio, y espera el resultado.
//
// Idempotente: Prisma migrate deploy no hace nada si las migrations ya estan aplicadas.

import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 60; // 5 min por servicio

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMigrationsFor(service) {
  const { serviceName, cluster, taskDefinition, subnets, securityGroups } = service;
  console.log(`[${serviceName}] starting migrations`);

  const runRes = await ecs.send(
    new RunTaskCommand({
      cluster,
      taskDefinition,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups,
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'app',
            command: ['sh', '-c', 'npx prisma migrate deploy --schema=./prisma/schema.prisma'],
          },
        ],
      },
      count: 1,
    }),
  );

  const taskArn = runRes.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error(`[${serviceName}] failed to start task: ${JSON.stringify(runRes.failures)}`);
  }
  console.log(`[${serviceName}] task started ${taskArn}`);

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const desc = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
    const task = desc.tasks?.[0];
    if (!task) continue;
    console.log(`[${serviceName}] status=${task.lastStatus} desiredStatus=${task.desiredStatus}`);
    if (task.lastStatus === 'STOPPED') {
      const container = task.containers?.find((c) => c.name === 'app');
      const exitCode = container?.exitCode;
      if (exitCode !== 0) {
        throw new Error(
          `[${serviceName}] migrations failed exitCode=${exitCode} reason=${task.stoppedReason ?? ''}`,
        );
      }
      console.log(`[${serviceName}] migrations OK`);
      return;
    }
  }
  throw new Error(`[${serviceName}] migrations timed out after ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`);
}

export const handler = async (event) => {
  console.log('event', JSON.stringify(event));
  const { RequestType, ResourceProperties } = event;

  if (RequestType === 'Delete') {
    return { PhysicalResourceId: 'leetcode-prisma-migrations' };
  }

  const services = ResourceProperties.Services ?? [];
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('Services prop missing or empty');
  }

  for (const svc of services) {
    await runMigrationsFor(svc);
  }

  return {
    PhysicalResourceId: 'leetcode-prisma-migrations',
    Data: { Ran: services.map((s) => s.serviceName).join(',') },
  };
};
