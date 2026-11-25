# create-escalay

```bash
npm create escalay@latest my-api     # the `api` preset: an agent-ready API with one example feature
npm create escalay@latest my-api -- --runtime node --title "My API"
npm create escalay@<version> my-api  # an app on that kit: each release after 1.31.0 depends on its own kit, exactly
                                     # (1.31.0 and older take the newest 1.x kit)
npm create escalay@latest -- --help  # the options
npx skills add escalay/api-kit -y    # in the app: your coding agent's skills, api-kit-build (parts, a newer kit), api-kit-feature, api-kit-review, api-kit-cli, api-kit-skills
```

Runs `init` from [`@escalay/kit`](https://github.com/escalay/api-kit) with the same arguments; its README lists them.
