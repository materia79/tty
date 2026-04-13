"use strict";

module.exports = {
  cmd: (ctx) => {
    ctx.app.scheduleRender();
    return "Terminal redrawn.";
  },
  help: "reset                      - redraw terminal and fix unicode rendering"
};
