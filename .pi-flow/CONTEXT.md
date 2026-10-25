# Factory context

This glossary preserves T3's existing terms and the software/research distinction agreed for t3code-factory. It does not specify an implementation.

| Term                  | Meaning                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory               | The proposed system for software delivery and research workflows, with shared task intake, execution, artifacts, and review.                        |
| Environment           | One running T3 server and the machine, filesystem, provider credentials, and state it owns. A remote client does not own these resources.           |
| Project               | An environment-local workspace record rooted at a directory. It is not a globally unique repository identity.                                       |
| Thread                | A durable conversation and work history for a project.                                                                                              |
| Provider              | An agent runtime or harness T3 talks to, not a Git hosting service or sandbox vendor.                                                               |
| Run                   | One user-to-agent cycle in T3. An experiment may involve several runs; the two terms are not interchangeable.                                       |
| Forge                 | A Git hosting service instance such as GitHub, GitLab, Forgejo/Codeberg, or Gitea.                                                                  |
| Forge synchronization | Keeping factory records current with a project's own forge. It does not imply copying tickets between different forges.                             |
| Software workflow     | Work whose output is an implementation with review and verification evidence. Merge and release are separate decisions.                             |
| Research workflow     | Work whose output is evidence addressing a question or hypothesis. A favorable metric alone is not a verified scientific conclusion.                |
| Experiment            | A bounded execution evaluated against declared criteria, with its code, environment, inputs, logs, and results recorded.                            |
| Inspiration source    | A project or account to study for useful capabilities or workflows. Inclusion does not imply adoption, source reuse permission, or achieved parity. |
| Parity                | A capability comparison supported by explicit scenarios and evidence at recorded revisions. Unreviewed capabilities have unknown parity.            |
