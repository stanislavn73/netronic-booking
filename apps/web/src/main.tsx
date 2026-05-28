import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApolloProvider } from '@apollo/client';
import { apollo } from './apollo';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApolloProvider client={apollo}>
      <App />
    </ApolloProvider>
  </StrictMode>,
);
