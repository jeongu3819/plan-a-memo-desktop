import React from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import App from './app/App';
import TitleBar, { TITLE_BAR_HEIGHT } from './app/TitleBar';
import { appTheme } from './app/theme';
import { createQueryClient } from './services/queries';
import { isTauri } from './tauri/api';
import './styles/global.css';

const queryClient = createQueryClient();
// 앱 창에서는 Windows 기본 제목 표시줄 대신 TitleBar 를 그린다(브라우저만 띄운 개발 화면에는 없음).
// Dialog 는 그 아래부터 덮는다(theme.ts 의 --title-bar-height).
const customFrame = isTauri();
if (customFrame) document.documentElement.style.setProperty('--title-bar-height', `${TITLE_BAR_HEIGHT}px`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        {/* 편집기(Web 공용 코드)가 쓰는 안내 알림 */}
        <SnackbarProvider maxSnack={3} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
          {customFrame && <TitleBar />}
          <div id="app-content">
            <App />
          </div>
        </SnackbarProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
