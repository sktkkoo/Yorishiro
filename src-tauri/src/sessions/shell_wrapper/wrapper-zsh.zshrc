# Charminal wrapper rc (zsh)
#
# Charminal が ZDOTDIR をこの dir に向けたときに zsh が読む .zshrc。
# auto-generated; do not edit. ~/.charminal/shell/user.zsh が user 拡張点。

# CHARMINAL_USER_ZDOTDIR には spawn 時の元 ZDOTDIR が入っている（unset の場合は無し）。
# ZDOTDIR を user 元に戻してから user の .zshrc を chain で source する。
if [[ -n "${CHARMINAL_USER_ZDOTDIR:-}" ]]; then
    ZDOTDIR="$CHARMINAL_USER_ZDOTDIR"
else
    unset ZDOTDIR
fi

# user の .zshrc を chain
if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
    source "${ZDOTDIR:-$HOME}/.zshrc"
fi

# Charminal integration (OSC 133)
[[ -f "$HOME/.charminal/shell/init.zsh" ]] && source "$HOME/.charminal/shell/init.zsh"

# user 拡張点（Charminal は touch しない）
[[ -f "$HOME/.charminal/shell/user.zsh" ]] && source "$HOME/.charminal/shell/user.zsh"
