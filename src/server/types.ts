export type Role = "owner" | "admin" | "operator" | "viewer";
export type DesiredState = "running" | "stopped";
export type AppKind = "web" | "worker";
export type RestartPolicy = "never" | "on-failure" | "always" | "unless-stopped";
export type SourceProvider = "github" | "harbur";
export type DeploymentState =
  | "queued"
  | "preparing"
  | "fetching"
  | "evaluating"
  | "starting"
  | "health-checking"
  | "activating"
  | "running"
  | "failed"
  | "cancelled"
  | "superseded"
  | "interrupted";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface AppRow {
  id: string;
  name: string;
  slug: string;
  kind: AppKind;
  repository_url: string;
  branch: string;
  flake_output: string;
  source_provider: SourceProvider;
  source_repository_id: string | null;
  source_connection_id: string | null;
  github_repository_id: number | null;
  github_installation_id: number | null;
  auto_deploy: number;
  desired_state: DesiredState;
  restart_policy: RestartPolicy;
  health_path: string;
  health_timeout_seconds: number;
  startup_timeout_seconds: number;
  public_port: number | null;
  active_internal_port: number | null;
  active_deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationConnectionRow {
  id: string;
  provider: "harbur";
  base_url: string;
  token_encrypted: string | null;
  allow_private_network: number;
  event_cursor: number;
  status: "connected" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRow {
  id: string;
  app_id: string;
  commit_sha: string | null;
  requested_ref: string;
  trigger: "manual" | "github_push" | "reconcile" | "restart";
  state: DeploymentState;
  release_dir: string | null;
  internal_port: number | null;
  pid: number | null;
  process_group_id: number | null;
  process_start_ticks: string | null;
  process_command_hash: string | null;
  process_command_summary: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  failure_code: string | null;
  failure_message: string | null;
  resource_confidence: "none" | "low" | "medium" | "high";
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  activated_at: string | null;
  cancel_requested: number;
}

export interface DeploymentWithAppRow extends DeploymentRow {
  app_name: string;
  app_kind: AppKind;
  app_desired_state: DesiredState;
  app_active_deployment_id: string | null;
}

export interface RuntimeMetric {
  timestamp: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  freeDiskBytes: number;
  loadAverage: number[];
  uptimeSeconds: number;
}
