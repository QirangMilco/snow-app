# 1-getting-started

This guide walks you through installing Snow App, running it for the first time, and basic configuration.

## 1. Installation

### Windows

1. Download the installer `Snow-App-Setup-<version>.exe`;
2. Double-click to run it and follow the wizard to complete the installation (you can choose the installation directory);
3. Launch Snow App from the Start menu or a desktop shortcut.

> A portable version `Snow-App-<version>.exe` is also available; it runs directly without installation.

### macOS

1. Download `Snow-App-<version>-<arch>.dmg` and drag it into Applications;
2. If it reports "damaged" or "cannot be opened" when launched, run the following in a terminal:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Snow\ App.app
```

### Linux

Download the installer for your distribution (AppImage / deb) and install it in the system-specific way.

## 2. First Run

After launch, the interface contains:

- **Sidebar**: project/workspace directory list, session list, memos
- **Main area**: AI chat, terminal, Git panel, browser panel, etc.
- **Top-right settings entry**: the gear icon opens the settings page

## 3. Basic Configuration

On first use, it is recommended to complete the following in order:

1. **Configure API keys**: Settings → API Settings, enter your model provider's key;
2. **Add a workspace directory**: Sidebar → Add Directory (local or SSH);
3. **(Optional) Configure a proxy**: Settings → Proxy & Browser, if your network requires a proxy;
4. **(Optional) Configure MCP servers**: Settings → MCP Settings, add external tool services.

Detailed steps for each configuration item can be found in the corresponding guide:

| Task | Guide |
| --- | --- |
| Configure MCP servers | [2-guides/1-configure-mcp](2-guides/1-configure-mcp.md) |
| Install & manage skills | [2-guides/2-install-and-manage-skills](2-guides/2-install-and-manage-skills.md) |
| Configure API keys & models | [2-guides/3-configure-api-keys](2-guides/3-configure-api-keys.md) |
| Configure proxy & network | [2-guides/4-configure-proxy](2-guides/4-configure-proxy.md) |

## 4. Next Steps

- Learn about the configuration file format: [3-reference/1-settings-json-reference](3-reference/1-settings-json-reference.md)
- Learn about the built-in tools available to the AI: [3-reference/2-builtin-tools-reference](3-reference/2-builtin-tools-reference.md)
