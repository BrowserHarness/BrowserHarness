# Progressive Autonomy

| Level | Name | BrowserHarness authority |
|---|---|---|
| A0 | Observe | Read-only observation/extraction |
| A1 | Draft | Plans/drafts; no external mutation |
| A2 | Assisted | Reversible mutation after explicit approval |
| A3 | Supervised | Validated Skills within limits; exceptions require approval |
| A4 | Autonomous | Proven Skills run automatically within defined policy |
| A5 | Autonomous + Recovery | Runs, verifies, detects faults and performs approved recovery |

## Effective authority
The strictest applicable limit wins across user permission, action policy, agent role, Skill ceiling and site/integration policy.

Credentials or logged-in sessions never imply authority.

Financial, destructive, public, customer-facing, legal/privacy-sensitive, security-changing and mass-communication actions require explicit policy and usually approval.

## Site approval grants (2026-10-04 decision)
Functionality comes before approval friction. On an approval card the user can choose "Always allow on this site"; approvals for consequential actions on that host and its subdomains are then granted automatically. Grants are local (`browserharness.siteApprovalGrants.v1`), listed and revocable under Settings → Permissions, and never apply to other sites. Without a grant, consequential actions still ask.
