/**
 * Decide whether to warn about `BIND_HOST=0.0.0.0` in production.
 *
 * Compose always sets `COMPOSE_PROJECT_NAME` automatically — its presence is
 * the signal that ingress is the compose bridge network (Caddy -> mcp-server),
 * so `0.0.0.0` is the correct bind and the warning would be noise. On a
 * bare-metal deploy the process binds to loopback via a reverse proxy; if
 * someone overrides `BIND_HOST=0.0.0.0` there, the warning stays load-bearing.
 */
export interface BindHostWarningInput {
  readonly nodeEnv: string;
  readonly bindHost: string;
  readonly composeProjectName: string | undefined;
}

export function shouldWarnBareBindHost(input: BindHostWarningInput): boolean {
  return (
    input.nodeEnv === 'production' &&
    input.bindHost === '0.0.0.0' &&
    input.composeProjectName === undefined
  );
}
