*{{ticket}} has to wait: it depends on earlier slices that are still open*

{{#deps.blockers}}
• slice {{slice}}: #{{number}} {{title}} ({{state}}) {{url}}
{{/deps.blockers}}
{{#deps.reason}}{{deps.reason}}{{/deps.reason}}

Nothing was built. Merge the pull requests for those slices (their pull requests say `Closes #N`, so merging closes them), then start this one again. To start it anyway, set ignore_dependencies to true.
