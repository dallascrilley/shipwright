export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface IssueContext extends IssueRef {
  title: string;
  body: string;
  defaultBranch: string;
  baseSha: string;
  installationId: number;
}

export interface PullRequestResult {
  number: number;
  url: string;
}
