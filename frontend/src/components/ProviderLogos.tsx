import React from 'react';

const IconWrapper = ({ children, bgClass, textClass }: { children: React.ReactNode, bgClass: string, textClass: string }) => (
  <div className={`w-8 h-8 rounded-full ${bgClass} ${textClass} flex items-center justify-center shrink-0`}>
    {children}
  </div>
);

export const ProviderLogo = ({ name, engine }: { name: string; engine?: string }) => {
  const eName = (engine || '').toLowerCase();
  const lName = name.toLowerCase();

  if (eName.includes('openai') || lName.includes('openai')) {
    return (
      <IconWrapper bgClass="bg-emerald-500/10 dark:bg-emerald-500/20" textClass="text-emerald-600 dark:text-emerald-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('claude') || eName.includes('anthropic') || lName.includes('claude')) {
    return (
      <IconWrapper bgClass="bg-amber-500/10 dark:bg-amber-500/20" textClass="text-amber-600 dark:text-amber-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Z" />
          <path d="M6.6959 3.541L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('gemini') || eName.includes('vertex') || lName.includes('gemini')) {
    return (
      <IconWrapper bgClass="bg-blue-500/10 dark:bg-blue-500/20" textClass="text-blue-600 dark:text-blue-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M12 2.586l1.828 5.485c.677 2.03 2.27 3.623 4.3 4.3L23.613 14.2l-5.485 1.828c-2.03.677-3.623 2.27-4.3 4.3L12 25.814l-1.828-5.485c-.677-2.03-2.27-3.623-4.3-4.3L.387 14.2l5.485-1.828c2.03-.677 3.623-2.27 4.3-4.3L12 2.586z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('aws') || lName.includes('aws') || lName.includes('bedrock')) {
    return (
      <IconWrapper bgClass="bg-orange-500/10 dark:bg-orange-500/20" textClass="text-orange-600 dark:text-orange-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M14.5 11.5c.2-.5.5-1 .8-1.5.3-.4.8-.8 1.4-1.2.6-.4 1.3-.7 2.1-.8.8-.2 1.7-.2 2.6 0v2.4c-.6-.2-1.3-.3-1.9-.3-.6 0-1.1.1-1.5.3-.4.2-.7.5-.9.9-.2.4-.3.9-.3 1.5 0 .6.1 1.1.3 1.5.2.4.6.7 1 .9.4.2.9.3 1.4.3.6 0 1.2-.1 1.8-.4v2.3c-.9.2-1.8.3-2.7.3-1 0-1.8-.1-2.5-.4-.7-.3-1.3-.7-1.8-1.2-.4-.5-.8-1.1-1-1.8l-1.4 3.2h-2.6l4.4-9.6zm-11 3.5l2.4-7.5h2.6l3 9.6h-2.4l-.6-2.1h-2.6l-.7 2.1H2.4l1.1-2.1zm2.3-4.1l-1 2.9h1.9l-.9-2.9zm13.1 5.9c-.8.8-1.7 1.4-2.8 1.8-1 .4-2.1.6-3.3.6-1.1 0-2.2-.2-3.1-.6s-1.8-1-2.5-1.7l1.3-1.8c.6.6 1.2 1 1.9 1.3.7.3 1.5.5 2.3.5.9 0 1.7-.2 2.4-.6.7-.4 1.2-.9 1.6-1.5l2.2 1.5z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('azure') || lName.includes('azure')) {
    return (
      <IconWrapper bgClass="bg-sky-500/10 dark:bg-sky-500/20" textClass="text-sky-600 dark:text-sky-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M22.22 21.04H1.78a1 1 0 0 1-.87-1.49l5.12-8.91a1 1 0 0 1 1.74 0l1.43 2.5-3.3 5.75h11.95l-4.57-7.95L11.53 7.82a1 1 0 0 1 1.74-1L23.1 19.55a1 1 0 0 1-.88 1.49zm-13.4-1.72h2.36l-1.18-2.06-1.18 2.06z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('cloudflare') || lName.includes('cloudflare')) {
    return (
      <IconWrapper bgClass="bg-amber-500/10 dark:bg-amber-500/20" textClass="text-amber-600 dark:text-amber-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M19.34 9.17A7.47 7.47 0 0 0 4.69 11C2.11 11.5 0 13.72 0 16.5 0 19.54 2.46 22 5.5 22h13c3.04 0 5.5-2.46 5.5-5.5 0-2.84-2.15-5.18-4.66-5.33z" />
        </svg>
      </IconWrapper>
    );
  }

  if (eName.includes('openrouter') || lName.includes('openrouter')) {
    return (
      <IconWrapper bgClass="bg-purple-500/10 dark:bg-purple-500/20" textClass="text-purple-600 dark:text-purple-500">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4.5 h-4.5">
          <path d="M 2.5 10 C 6 10, 8.5 4.5, 13.5 4.5 L 13.5 2 L 22.5 6.5 L 13.5 11 L 13.5 8.5 C 7 8.5, 7 15.5, 13.5 15.5 L 13.5 13 L 22.5 17.5 L 13.5 22 L 13.5 19.5 C 8.5 19.5, 6 14, 2.5 14 Z" />
        </svg>
      </IconWrapper>
    );
  }

  return (
    <IconWrapper bgClass="bg-muted" textClass="text-muted-foreground font-bold text-sm">
      {(name || 'U')[0].toUpperCase()}
    </IconWrapper>
  );
};
