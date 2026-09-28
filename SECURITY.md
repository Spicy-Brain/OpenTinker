# Security

OpenTinker runs PHP code in your application's runtime with the same power as
`php artisan tinker`, including on remote servers over SSH. We take reports about it
seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the OpenTinker, VS Code and PHP
versions involved. We aim to acknowledge reports within a week.

## Scope

In scope, for example:

- running code without an explicit user action, or in an untrusted workspace;
- the production guard failing to ask before a run that it should catch;
- the results panel executing script from app data (dumps, previews, errors);
- SSH host key checking being bypassed, or the worker upload being writable by other
  users;
- run history or kept results leaking outside the workspace's storage.

Out of scope: code you run yourself doing what it says, and the behaviour of your own
application, Docker, SSH or PHP.

## Supported versions

Security fixes go into the latest release.
