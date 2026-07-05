# Yorishiro wrapper rc (zsh)
#
# Yorishiro が ZDOTDIR をこの dir に向けたときに zsh が読む .zshrc。
# auto-generated; do not edit. ~/.yorishiro/shell/user.zsh が user 拡張点。

# YORISHIRO_USER_ZDOTDIR には spawn 時の元 ZDOTDIR が入っている（unset の場合は無し）。
# ZDOTDIR を user 元に戻してから user の .zshrc を chain で source する。
if [[ -n "${YORISHIRO_USER_ZDOTDIR:-}" ]]; then
    ZDOTDIR="$YORISHIRO_USER_ZDOTDIR"
else
    unset ZDOTDIR
fi

# user の .zshrc を chain
if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
    source "${ZDOTDIR:-$HOME}/.zshrc"
fi

# Yorishiro integration (OSC 133)
[[ -f "$HOME/.yorishiro/shell/init.zsh" ]] && source "$HOME/.yorishiro/shell/init.zsh"

# user 拡張点（Yorishiro は touch しない）
[[ -f "$HOME/.yorishiro/shell/user.zsh" ]] && source "$HOME/.yorishiro/shell/user.zsh"
