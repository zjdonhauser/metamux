-- metamux optional layout helper for Hammerspoon.
-- Append to ~/.hammerspoon/init.lua (or require this file), reload Hammerspoon,
-- then run:  hs -c 'metamuxDock()'
-- Tiles cmux on the left 55% and the frontmost Chrome window on the right 45%.
-- One-shot positioning by design; live drag-following is deliberately out of scope.

function metamuxDock()
  local screen = hs.screen.mainScreen():frame()
  local split = 0.55

  local cmux = hs.application.get("cmux")
  if cmux and cmux:mainWindow() then
    cmux:mainWindow():setFrame({
      x = screen.x, y = screen.y,
      w = screen.w * split, h = screen.h,
    })
  end

  local chrome = hs.application.get("Google Chrome")
  if chrome then
    -- Prefer the window whose title carries the metamux marker tab; fall back to main window.
    local target = nil
    for _, win in ipairs(chrome:allWindows()) do
      if string.find(win:title() or "", "metamux", 1, true) then
        target = win
        break
      end
    end
    target = target or chrome:mainWindow()
    if target then
      target:setFrame({
        x = screen.x + screen.w * split, y = screen.y,
        w = screen.w * (1 - split), h = screen.h,
      })
    end
  end
end
