import React from 'react';

import { Button } from '@actual-app/components/button';
import { View } from '@actual-app/components/view';

import { useTagCSS } from '@desktop-client/hooks/useTagCSS';

type DesktopTaggedNotesProps = {
  content: string;
  comment?: string;
  onPress?: (content: string) => void;
  tag: string;
  separator: string;
};

export function DesktopTaggedNotes({
  content,
  comment,
  onPress,
  tag,
  separator,
}: DesktopTaggedNotesProps) {
  const getTagCSS = useTagCSS();
  return (
    <View style={{ display: 'inline' }}>
      <Button
        variant="bare"
        className={getTagCSS(tag)}
        title={comment}
        onPress={() => {
          onPress?.(content);
        }}
      >
        {content}
      </Button>
      {separator}
    </View>
  );
}
