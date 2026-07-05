# Yorishiro wrapper rc (bash)
#
# bash --rcfile で読まれる init script。auto-generated; do not edit.
# ~/.yorishiro/shell/user.bash が user 拡張点。

# user の .bashrc を chain
if [ -f "$HOME/.bashrc" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.bashrc"
fi

# Yorishiro integration (OSC 133)
if [ -f "$HOME/.yorishiro/shell/init.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.yorishiro/shell/init.bash"
fi

# user 拡張点
if [ -f "$HOME/.yorishiro/shell/user.bash" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.yorishiro/shell/user.bash"
fi
