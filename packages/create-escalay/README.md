# create-escalay

```bash
npm create escalay my-api            # the `api` preset: an agent-ready API with one example feature
npm create escalay my-api -- --runtime node --title "My API"
npm create escalay@<version> my-api  # an app on that kit: each release after 1.31.0 depends on its own kit, exactly
                                     # (1.31.0 and older take the newest 1.x kit)
npm create escalay -- --help         # the options
```

Runs `init` from [`@escalay/kit`](https://github.com/escalay/api-kit) with the same arguments; its README lists them.
