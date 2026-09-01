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

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface PullRequestContext extends PullRequestRef {
  title: string;
  body: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  draft: boolean;
  installationId: number;
}

export interface ReviewComment {
  id: string;
  body: string;
  url: string;
  author: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewComment[];
}

export interface PullRequestReview {
  id: string;
  state: string;
  body: string;
  author: string;
}
